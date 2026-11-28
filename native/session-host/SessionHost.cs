// Pi Computer Use session host.
//
// An SSH login on Windows runs in the services session, not on the user's desktop. This program has two halves:
//   Server  (`pi-session-host.exe serve <pipe>`) runs in the user's interactive session, started by a one-shot
//           scheduled task, and starts programs there on request, with their standard streams bridged over a named pipe.
//   Client  (`pi-session-client.exe run <pipe> <request>`, the same source built as a console program) is what the SSH
//           command runs: it bridges its own standard streams to one program started by the server.
// The pipe belongs to the current user alone and refuses network clients. Nothing listens on a TCP port.
// Written in C# 5: it is compiled on the target with the .NET Framework compiler that ships with Windows.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace PiSessionHost
{
    /// <summary>Frames on the pipe: one type byte, a little-endian length, the payload.</summary>
    internal static class Frames
    {
        // Client to server.
        public const byte Request = 1, Stdin = 2, StdinEnd = 3;
        // Server to client.
        public const byte Hello = 16, Stdout = 17, Stderr = 18, Exit = 19, Failure = 20;
        public const int MaxPayload = 8 * 1024 * 1024;

        public static void Write(Stream stream, byte type, byte[] data, int offset, int count)
        {
            byte[] header = new byte[5];
            header[0] = type;
            header[1] = (byte)count; header[2] = (byte)(count >> 8); header[3] = (byte)(count >> 16); header[4] = (byte)(count >> 24);
            lock (stream)
            {
                stream.Write(header, 0, 5);
                if (count > 0) stream.Write(data, offset, count);
                stream.Flush();
            }
        }

        public static void Write(Stream stream, byte type, string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            Write(stream, type, bytes, 0, bytes.Length);
        }

        private static bool ReadExactly(Stream stream, byte[] buffer, int count)
        {
            int done = 0;
            while (done < count)
            {
                int read = stream.Read(buffer, done, count - done);
                if (read <= 0) return false;
                done += read;
            }
            return true;
        }

        /// <summary>The next frame, or false at the end of the stream.</summary>
        public static bool Read(Stream stream, out byte type, out byte[] data)
        {
            type = 0; data = null;
            byte[] header = new byte[5];
            if (!ReadExactly(stream, header, 5)) return false;
            int length = header[1] | (header[2] << 8) | (header[3] << 16) | (header[4] << 24);
            if (length < 0 || length > MaxPayload) throw new IOException("Invalid frame length.");
            data = new byte[length];
            if (length > 0 && !ReadExactly(stream, data, length)) return false;
            type = header[0];
            return true;
        }
    }

    /// <summary>
    /// A standard handle of this process. Windows OpenSSH hands its child pipes opened for overlapped I/O; the .NET console
    /// streams read them synchronously and never see data that arrives after the read began. Every call here names an
    /// OVERLAPPED and waits for it, which is right for both kinds of handle.
    /// </summary>
    internal sealed class StandardStream : Stream
    {
        private const int BufferSize = 65536, IoPending = 997, BrokenPipe = 109, HandleEof = 38, PipeNotConnected = 233;
        private readonly IntPtr handle;
        private readonly ManualResetEvent done = new ManualResetEvent(false);
        private readonly IntPtr buffer = Marshal.AllocHGlobal(BufferSize);

        [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int which);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(IntPtr file, IntPtr data, int count, out int read, ref NativeOverlapped overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WriteFile(IntPtr file, IntPtr data, int count, out int written, ref NativeOverlapped overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetOverlappedResult(IntPtr file, ref NativeOverlapped overlapped, out int transferred, bool wait);

        public StandardStream(int which)
        {
            handle = GetStdHandle(which);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new IOException("The process has no such standard stream.");
        }

        /// <summary>One transfer; false at the end of the stream.</summary>
        private bool Transfer(bool reading, int count, out int transferred)
        {
            done.Reset();
            NativeOverlapped overlapped = new NativeOverlapped();
            overlapped.EventHandle = done.SafeWaitHandle.DangerousGetHandle();
            bool ok = reading ? ReadFile(handle, buffer, count, out transferred, ref overlapped) : WriteFile(handle, buffer, count, out transferred, ref overlapped);
            if (ok) return true;
            int error = Marshal.GetLastWin32Error();
            if (error == IoPending)
            {
                if (GetOverlappedResult(handle, ref overlapped, out transferred, true)) return true;
                error = Marshal.GetLastWin32Error();
            }
            transferred = 0;
            if (reading && (error == BrokenPipe || error == HandleEof || error == PipeNotConnected)) return false;
            throw new IOException("Standard stream failed with Windows error " + error + ".");
        }

        public override int Read(byte[] data, int offset, int count)
        {
            int read;
            if (!Transfer(true, Math.Min(count, BufferSize), out read) || read == 0) return 0;
            Marshal.Copy(buffer, data, offset, read);
            return read;
        }

        public override void Write(byte[] data, int offset, int count)
        {
            while (count > 0)
            {
                int chunk = Math.Min(count, BufferSize), written;
                Marshal.Copy(data, offset, buffer, chunk);
                Transfer(false, chunk, out written);
                offset += written; count -= written;
            }
        }

        public override void Flush() { }
        public override bool CanRead { get { return true; } }
        public override bool CanWrite { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
    }

    internal static class Native
    {
        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
        [DllImport("wtsapi32.dll")]
        public static extern void WTSFreeMemory(IntPtr memory);

        [StructLayout(LayoutKind.Sequential)]
        public struct SessionInfo { public int SessionId; public IntPtr WinStationName; public int State; }
    }

    /// <summary>The Windows sessions of the current user that are connected to a desktop.</summary>
    public static class Sessions
    {
        private static string Query(int session, int info)
        {
            IntPtr buffer; int bytes;
            if (!Native.WTSQuerySessionInformation(IntPtr.Zero, session, info, out buffer, out bytes)) return "";
            try { return Marshal.PtrToStringUni(buffer) ?? ""; }
            finally { Native.WTSFreeMemory(buffer); }
        }

        /// <summary>Ids of sessions that are active (state 0), not the services session 0, and belong to the current user.</summary>
        public static int[] ActiveOfCurrentUser()
        {
            IntPtr list; int count;
            if (!Native.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out list, out count)) throw new IOException("Windows did not list its sessions.");
            List<int> found = new List<int>();
            try
            {
                int size = Marshal.SizeOf(typeof(Native.SessionInfo));
                string user = Environment.UserName;
                string domain = Environment.UserDomainName;
                for (int i = 0; i < count; i++)
                {
                    Native.SessionInfo info = (Native.SessionInfo)Marshal.PtrToStructure(new IntPtr(list.ToInt64() + (long)i * size), typeof(Native.SessionInfo));
                    if (info.SessionId == 0 || info.State != 0) continue;
                    // WTSUserName = 5, WTSDomainName = 7
                    if (string.Equals(Query(info.SessionId, 5), user, StringComparison.OrdinalIgnoreCase)
                        && string.Equals(Query(info.SessionId, 7), domain, StringComparison.OrdinalIgnoreCase)) found.Add(info.SessionId);
                }
            }
            finally { Native.WTSFreeMemory(list); }
            return found.ToArray();
        }
    }

    /// <summary>One request: the program to start in the interactive session.</summary>
    internal class Request
    {
        public string file = null;
        public string[] args = null;
        public Dictionary<string, string> env = null;
    }

    /// <summary>Runs in the interactive session and starts requested programs with their streams on the pipe.</summary>
    public static class Server
    {
        private static int active;
        private static long lastActivity = Environment.TickCount;
        private static bool everConnected;
        private const int IdleMilliseconds = 30000;
        private const int FirstConnectionMilliseconds = 120000;
        private const int ExitGraceMilliseconds = 5000;

        internal static string Quote(string value)
        {
            // The quoting CommandLineToArgvW and the C runtime read back.
            if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            StringBuilder builder = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { builder.Append('\\', slashes * 2 + 1); builder.Append('"'); }
                else { builder.Append('\\', slashes); builder.Append(c); }
                slashes = 0;
            }
            builder.Append('\\', slashes * 2);
            builder.Append('"');
            return builder.ToString();
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern Microsoft.Win32.SafeHandles.SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances,
            uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes attributes);

        /// <summary>
        /// One instance of the pipe, usable by the current user alone and never over the network. The SSH logon itself carries
        /// the NETWORK group, so remote access is refused by the pipe's own flag instead of an access rule.
        /// </summary>
        private static NamedPipeServerStream CreateInstance(string pipe, bool first)
        {
            PipeSecurity security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
            IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
            try
            {
                Marshal.Copy(descriptor, 0, memory, descriptor.Length);
                SecurityAttributes attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                attributes.Descriptor = memory;
                // Overlapped I/O: one thread reads the pipe while others write it, which a synchronous handle would serialize.
                const uint Duplex = 3, Overlapped = 0x40000000, FirstInstance = 0x00080000, RejectRemoteClients = 8;
                Microsoft.Win32.SafeHandles.SafePipeHandle handle = CreateNamedPipe("\\\\.\\pipe\\" + pipe, Duplex | Overlapped | (first ? FirstInstance : 0),
                    RejectRemoteClients, 255, 65536, 65536, 0, ref attributes);
                if (handle.IsInvalid) throw new IOException("The session pipe could not be created (error " + Marshal.GetLastWin32Error() + ").");
                return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
            }
            finally { Marshal.FreeHGlobal(memory); }
        }

        public static int Run(string pipe)
        {
            bool created;
            using (Mutex single = new Mutex(true, "Local\\PiComputerUse.SessionHost." + pipe, out created))
            {
                if (!created) return 0;
                Thread watchdog = new Thread(Watch);
                watchdog.IsBackground = true;
                watchdog.Start();
                bool first = true;
                for (;;)
                {
                    NamedPipeServerStream stream = CreateInstance(pipe, first);
                    first = false;
                    stream.WaitForConnection();
                    Interlocked.Increment(ref active);
                    everConnected = true;
                    Thread handler = new Thread(delegate () { Handle(stream); });
                    handler.IsBackground = true;
                    handler.Start();
                }
            }
        }

        private static void Watch()
        {
            for (;;)
            {
                Thread.Sleep(1000);
                long idle = Environment.TickCount - Interlocked.Read(ref lastActivity);
                if (Thread.VolatileRead(ref active) == 0 && idle > (everConnected ? IdleMilliseconds : FirstConnectionMilliseconds)) Environment.Exit(0);
            }
        }

        private static void Handle(NamedPipeServerStream pipe)
        {
            Process child = null;
            try
            {
                Frames.Write(pipe, Frames.Hello, "{\"session\":" + Process.GetCurrentProcess().SessionId + "}");
                byte type; byte[] data;
                if (!Frames.Read(pipe, out type, out data) || type != Frames.Request) return;
                Request request = new JavaScriptSerializer().Deserialize<Request>(Encoding.UTF8.GetString(data));
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = request.file;
                StringBuilder line = new StringBuilder();
                if (request.args != null) foreach (string arg in request.args) { if (line.Length > 0) line.Append(' '); line.Append(Quote(arg)); }
                info.Arguments = line.ToString();
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardInput = info.RedirectStandardOutput = info.RedirectStandardError = true;
                if (request.env != null) foreach (KeyValuePair<string, string> pair in request.env) info.EnvironmentVariables[pair.Key] = pair.Value;
                try { child = Process.Start(info); }
                catch (Exception error) { Frames.Write(pipe, Frames.Failure, "Could not start " + request.file + ": " + error.Message); return; }

                Thread outPump = new Thread(delegate () { Pump(child.StandardOutput.BaseStream, pipe, Frames.Stdout); });
                Thread errPump = new Thread(delegate () { Pump(child.StandardError.BaseStream, pipe, Frames.Stderr); });
                outPump.IsBackground = errPump.IsBackground = true;
                outPump.Start(); errPump.Start();

                Process owned = child;
                Thread input = new Thread(delegate () { Feed(pipe, owned); });
                input.IsBackground = true;
                input.Start();

                owned.WaitForExit();
                outPump.Join(5000); errPump.Join(5000);
                byte[] code = BitConverter.GetBytes(owned.ExitCode);
                Frames.Write(pipe, Frames.Exit, code, 0, 4);
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            finally
            {
                // A client that is gone (SSH ended) takes its program with it, after the program had its chance to exit on EOF.
                if (child != null)
                {
                    try { child.StandardInput.Close(); } catch (Exception) { }
                    try { if (!child.WaitForExit(ExitGraceMilliseconds)) child.Kill(); } catch (Exception) { }
                }
                try { pipe.Dispose(); } catch (Exception) { }
                Interlocked.Exchange(ref lastActivity, Environment.TickCount);
                Interlocked.Decrement(ref active);
            }
        }

        private static void Pump(Stream from, Stream pipe, byte type)
        {
            byte[] buffer = new byte[65536];
            try
            {
                int read;
                while ((read = from.Read(buffer, 0, buffer.Length)) > 0) Frames.Write(pipe, type, buffer, 0, read);
            }
            catch (Exception) { }
        }

        /// <summary>Client frames to the program's input; the end of the client's input, or its disappearance, closes it.</summary>
        private static void Feed(Stream pipe, Process child)
        {
            bool ended = false;
            try
            {
                byte type; byte[] data;
                while (Frames.Read(pipe, out type, out data))
                {
                    if (type == Frames.Stdin) { child.StandardInput.BaseStream.Write(data, 0, data.Length); child.StandardInput.BaseStream.Flush(); }
                    else if (type == Frames.StdinEnd) { ended = true; break; }
                }
            }
            catch (Exception) { }
            try { child.StandardInput.Close(); } catch (Exception) { }
            if (ended) return;
            // The client vanished without ending its input (SSH dropped): the program gets time to exit on EOF, then goes.
            try { if (!child.WaitForExit(ExitGraceMilliseconds)) child.Kill(); } catch (Exception) { }
        }
    }

    /// <summary>Runs in the SSH session: bridges this process's streams to one program in the interactive session.</summary>
    public static class Client
    {
        public static bool PipeExists(string pipe)
        {
            try { return File.Exists("\\\\.\\pipe\\" + pipe); } catch (Exception) { return false; }
        }

        /// <summary>
        /// Connect to the server, check that it runs in an active session of this user, start the request and bridge
        /// the streams. Returns the program's exit code; 125 means the helper itself failed (message on stderr).
        /// </summary>
        public static int Run(string pipe, string requestJson)
        {
            Stream stdout = new StandardStream(-11);
            Stream stderr = new StandardStream(-12);
            Stream stdin = new StandardStream(-10);
            try
            {
                if (string.IsNullOrEmpty(requestJson)) return Fail(stderr, "No request was given to the session helper.");
                using (NamedPipeClientStream stream = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
                {
                    stream.Connect(10000);
                    byte type; byte[] data;
                    if (!Frames.Read(stream, out type, out data) || type != Frames.Hello) return Fail(stderr, "The session helper did not greet.");
                    int session = (int)(new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(data))["session"]);
                    if (Array.IndexOf(Sessions.ActiveOfCurrentUser(), session) < 0)
                        return Fail(stderr, "The session helper runs in session " + session + ", which is not an active session of this user any more. Sign in on the intended desktop and connect again.");
                    Frames.Write(stream, Frames.Request, requestJson);
                    Thread input = new Thread(delegate () { Forward(stdin, stream); });
                    input.IsBackground = true;
                    input.Start();
                    while (Frames.Read(stream, out type, out data))
                    {
                        if (type == Frames.Stdout) { stdout.Write(data, 0, data.Length); stdout.Flush(); }
                        else if (type == Frames.Stderr) { stderr.Write(data, 0, data.Length); stderr.Flush(); }
                        else if (type == Frames.Exit) return BitConverter.ToInt32(data, 0);
                        else if (type == Frames.Failure) return Fail(stderr, Encoding.UTF8.GetString(data));
                    }
                    return Fail(stderr, "The session helper closed the connection before the program ended.");
                }
            }
            catch (Exception error) { return Fail(stderr, "Could not reach the session helper: " + error.Message); }
        }

        private static void Forward(Stream stdin, Stream pipe)
        {
            byte[] buffer = new byte[65536];
            try
            {
                int read;
                while ((read = stdin.Read(buffer, 0, buffer.Length)) > 0) Frames.Write(pipe, Frames.Stdin, buffer, 0, read);
                Frames.Write(pipe, Frames.StdinEnd, buffer, 0, 0);
            }
            catch (Exception) { }
        }

        private static int Fail(Stream stderr, string message)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(message + "\n");
            stderr.Write(bytes, 0, bytes.Length);
            stderr.Flush();
            return 125;
        }
    }

    internal static class Program
    {
        /// <summary>
        /// Start the helper in the interactive session unless its pipe exists, through session-start.ps1 beside this program.
        /// Its standard input is closed at once: Windows PowerShell must not read the stream that belongs to the program.
        /// </summary>
        private static int Ensure(string pipe, Stream stderr)
        {
            if (Client.PipeExists(pipe)) return 0;
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = "powershell.exe";
            info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Server.Quote(Path.Combine(folder, "session-start.ps1"))
                + " " + Server.Quote(Path.Combine(folder, "pi-session-host.exe")) + " " + Server.Quote(pipe);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = info.RedirectStandardOutput = info.RedirectStandardError = true;
            using (Process start = Process.Start(info))
            {
                start.StandardInput.Close();
                // Both streams are drained so the child never blocks on a full pipe.
                string output = null;
                Thread drain = new Thread(delegate () { output = start.StandardOutput.ReadToEnd(); });
                drain.Start();
                string error = start.StandardError.ReadToEnd();
                start.WaitForExit();
                drain.Join();
                if (start.ExitCode == 0) return 0;
                byte[] bytes = Encoding.UTF8.GetBytes((error.Trim().Length > 0 ? error.Trim() : "The session helper could not be started.") + "\n");
                stderr.Write(bytes, 0, bytes.Length);
                return 125;
            }
        }

        /// <summary>serve PIPE | ensure PIPE | run PIPE [BASE64-REQUEST]</summary>
        public static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "serve") return Server.Run(args[1]);
            Stream stderr = new StandardStream(-12);
            if (args.Length == 2 && args[0] == "ensure") return Ensure(args[1], stderr);
            if ((args.Length == 2 || args.Length == 3) && args[0] == "run")
            {
                int ensured = Ensure(args[1], stderr);
                if (ensured != 0) return ensured;
                string request = args.Length == 3 ? Encoding.UTF8.GetString(Convert.FromBase64String(args[2])) : null;
                return Client.Run(args[1], request);
            }
            byte[] usage = Encoding.UTF8.GetBytes("usage: pi-session-client run PIPE [BASE64-REQUEST] | ensure PIPE\n");
            stderr.Write(usage, 0, usage.Length);
            return 2;
        }
    }
}
