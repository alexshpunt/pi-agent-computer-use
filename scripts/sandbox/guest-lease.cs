// Shared Windows Sandbox input lease: agents take turns with the guest's one mouse and keyboard.
// Compiled by Windows PowerShell's Add-Type, so it stays within C# 5.
//
// Protocol: one TCP connection per agent session, UTF-8 lines.
//   C: auth <token> <agent>   S: ok                  (anything else closes the connection)
//   C: acquire                S: granted <waited_ms> <revoked 0|1>
//   C: release                S: released | held <reason>
//   C: claim <pid>            S: claimed | taken      (a process belongs to the first agent that claims it)
//   C: state                  S: state holder=<agent|-> sticky=<0|1> waiting=<n> seated=<n>
//   C: join                   S: zone <x> <y> <width> <height> <index> <count> <screen width> <screen height> | full <count>
//   C: zone                   S: zone ... (as join) | none
//   C: leave                  (the server closes the connection; the zone goes at once)
// join gives the agent its own zone of the guest screen (guest-zones.cs), at most PiZones.MaxSeats agents; zone tells
// its current zone, which changes as agents join and leave. Rectangles are physical guest pixels of the work area.
// A connection that closes without leave keeps its agent's zone for 10 s, so the agent gets it back when it reconnects.
// The holder keeps the lease after release while the foreground thread shows transient UI (a menu, mouse capture,
// move/size mode) or a mouse button or modifier key is down. That sticky lease ends at the holder's next acquire, or
// when another agent waits and StickyMs have passed: then the guest presses Escape, releases buttons and keys, and the
// next agent in line gets the lease. A closed connection gives up the lease the same way, and the agent's claims.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PiInputLease
{
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct GuiThreadInfo
    {
        public int Size; public int Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MouseInput { public int Dx, Dy; public uint Data, Flags, Time; public IntPtr Extra; }

    [StructLayout(LayoutKind.Sequential)]
    struct KeyboardInput { public ushort Vk, Scan; public uint Flags, Time; public IntPtr Extra; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }

    [StructLayout(LayoutKind.Sequential)]
    struct Input { public uint Type; public InputUnion Data; }

    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);

    const int GuiInMoveSize = 0x2, GuiInMenuMode = 0x4, GuiSystemMenuMode = 0x8, GuiPopupMenuMode = 0x10;
    static readonly int[] Buttons = { 0x01, 0x02, 0x04, 0x05, 0x06 };
    static readonly uint[] ButtonUps = { 0x0004, 0x0010, 0x0040, 0x0100, 0x0100 };
    static readonly uint[] ButtonData = { 0, 0, 0, 1, 2 };
    static readonly int[] Modifiers = { 0x10, 0x11, 0x12, 0x5B, 0x5C };

    class Agent { public string Name; }

    static readonly object Gate = new object();
    static readonly LinkedList<Agent> Waiting = new LinkedList<Agent>();
    static readonly Dictionary<int, Agent> Claims = new Dictionary<int, Agent>();
    static Agent holder;
    static bool sticky;
    static DateTime stickySince;
    static int stickyMs = 15000;

    /// Why the guest's input is not idle right now, or null when it is.
    public static string Transient()
    {
        GuiThreadInfo info = new GuiThreadInfo();
        info.Size = Marshal.SizeOf(typeof(GuiThreadInfo));
        if (GetGUIThreadInfo(0, ref info))
        {
            if ((info.Flags & (GuiInMenuMode | GuiPopupMenuMode | GuiSystemMenuMode)) != 0 || info.MenuOwner != IntPtr.Zero) return "menu";
            if ((info.Flags & GuiInMoveSize) != 0 || info.MoveSize != IntPtr.Zero) return "move_size";
            if (info.Capture != IntPtr.Zero) return "capture";
        }
        foreach (int key in Buttons) if ((GetAsyncKeyState(key) & 0x8000) != 0) return "button";
        foreach (int key in Modifiers) if ((GetAsyncKeyState(key) & 0x8000) != 0) return "key";
        return null;
    }

    /// Close transient UI and release every pressed button and modifier, so the next agent starts from idle input.
    public static void Reset()
    {
        List<Input> inputs = new List<Input>();
        for (int i = 0; i < Buttons.Length; i++)
        {
            if ((GetAsyncKeyState(Buttons[i]) & 0x8000) == 0) continue;
            Input input = new Input { Type = 0 };
            input.Data.Mouse = new MouseInput { Flags = ButtonUps[i], Data = ButtonData[i] };
            inputs.Add(input);
        }
        foreach (int key in Modifiers)
        {
            if ((GetAsyncKeyState(key) & 0x8000) == 0) continue;
            inputs.Add(Key((ushort)key, true));
        }
        string transient = Transient();
        if (transient == "menu" || transient == "move_size" || transient == "capture")
        {
            inputs.Add(Key(0x1B, false));
            inputs.Add(Key(0x1B, true));
        }
        if (inputs.Count > 0) SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Input)));
    }

    static Input Key(ushort vk, bool up)
    {
        Input input = new Input { Type = 1 };
        input.Data.Keyboard = new KeyboardInput { Vk = vk, Flags = up ? 0x0002u : 0u };
        return input;
    }

    /// The agent closed its connection: a readable socket with no data has reached its end.
    static bool Gone(Socket socket)
    {
        try { return socket.Poll(0, SelectMode.SelectRead) && socket.Available == 0; }
        catch (SocketException) { return true; }
        catch (ObjectDisposedException) { return true; }
    }

    /// Wait until this agent is first in line and the lease is free; a sticky lease past its time is revoked. An agent
    /// that cancels its wait closes the connection: it leaves the line at once, so it never revokes another agent's menu.
    static string Acquire(Agent agent, Socket socket)
    {
        DateTime started = DateTime.UtcNow;
        bool revoked = false;
        lock (Gate)
        {
            if (holder == agent) { sticky = false; return "granted 0 0"; }
            LinkedListNode<Agent> node = Waiting.AddLast(agent);
            try
            {
                while (true)
                {
                    if (Gone(socket)) throw new IOException("The agent left while waiting for the lease.");
                    if (holder != null && sticky && Waiting.First == node && (DateTime.UtcNow - stickySince).TotalMilliseconds >= stickyMs)
                    {
                        Reset();
                        holder = null;
                        sticky = false;
                        revoked = true;
                    }
                    if (holder == null && Waiting.First == node) break;
                    int wait = 250;
                    if (holder != null && sticky)
                    {
                        double left = stickyMs - (DateTime.UtcNow - stickySince).TotalMilliseconds;
                        wait = (int)Math.Max(1, Math.Min(wait, left));
                    }
                    Monitor.Wait(Gate, wait);
                }
            }
            finally { Waiting.Remove(node); Monitor.PulseAll(Gate); }
            holder = agent;
            sticky = false;
        }
        long waited = (long)(DateTime.UtcNow - started).TotalMilliseconds;
        return "granted " + waited + " " + (revoked ? 1 : 0);
    }

    static string Release(Agent agent)
    {
        lock (Gate)
        {
            if (holder != agent) return "released";
            string transient = Transient();
            if (transient != null)
            {
                sticky = true;
                stickySince = DateTime.UtcNow;
                Monitor.PulseAll(Gate);
                return "held " + transient;
            }
            holder = null;
            sticky = false;
            Monitor.PulseAll(Gate);
            return "released";
        }
    }

    static string Claim(Agent agent, string pid)
    {
        int id;
        if (!int.TryParse(pid, out id) || id <= 0) return "taken";
        lock (Gate)
        {
            Agent owner;
            // A new connection of the same agent takes its claims over from one the guest has not seen close yet.
            if (Claims.TryGetValue(id, out owner) && owner != agent && owner.Name != agent.Name) return "taken";
            Claims[id] = agent;
        }
        PiZones.Claimed(id, agent.Name, agent);
        return "claimed";
    }

    static void Leave(Agent agent, bool left)
    {
        lock (Gate)
        {
            List<int> mine = new List<int>();
            foreach (KeyValuePair<int, Agent> claim in Claims) if (claim.Value == agent) mine.Add(claim.Key);
            foreach (int id in mine) Claims.Remove(id);
            if (holder == agent)
            {
                Reset();
                holder = null;
                sticky = false;
            }
            Monitor.PulseAll(Gate);
        }
        PiZones.Leave(agent.Name, agent, left);
    }

    static string State()
    {
        lock (Gate)
        {
            return "state holder=" + (holder == null ? "-" : holder.Name) + " sticky=" + (sticky ? 1 : 0) + " waiting=" + Waiting.Count + " seated=" + PiZones.Seated;
        }
    }

    static bool SameToken(string actual, string expected)
    {
        if (actual == null) return false;
        int difference = actual.Length ^ expected.Length;
        for (int i = 0; i < Math.Max(actual.Length, expected.Length); i++)
            difference |= (i < actual.Length ? actual[i] : 0) ^ (i < expected.Length ? expected[i] : 0);
        return difference == 0;
    }

    static void Serve(TcpClient client, string token)
    {
        Agent agent = null;
        bool left = false;
        try
        {
            client.NoDelay = true;
            NetworkStream stream = client.GetStream();
            StreamReader reader = new StreamReader(stream, new UTF8Encoding(false));
            StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false));
            writer.NewLine = "\n";
            writer.AutoFlush = true;
            client.ReceiveTimeout = 5000;
            string first = reader.ReadLine();
            string[] hello = first == null ? new string[0] : first.Split(' ');
            if (hello.Length != 3 || hello[0] != "auth" || !SameToken(hello[1], token) || hello[2].Length == 0 || hello[2].Length > 80) return;
            client.ReceiveTimeout = 0;
            agent = new Agent { Name = hello[2] };
            writer.WriteLine("ok");
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line == "acquire") writer.WriteLine(Acquire(agent, client.Client));
                else if (line == "release") writer.WriteLine(Release(agent));
                else if (line == "state") writer.WriteLine(State());
                else if (line.StartsWith("claim ")) writer.WriteLine(Claim(agent, line.Substring(6)));
                else if (line == "join") writer.WriteLine(PiZones.Join(agent.Name, agent) ?? "full " + PiZones.Seated);
                else if (line == "zone") writer.WriteLine(PiZones.ZoneOf(agent.Name) ?? "none");
                else if (line == "leave") { left = true; return; }
                else return;
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            if (agent != null) Leave(agent, left);
            client.Close();
        }
    }

    /// Serve leases until the process ends. Each connection gets its own thread; agents are few.
    public static void Run(int port, string token, int stickyMilliseconds)
    {
        if (token == null || token.Length < 32) throw new ArgumentException("A lease token of at least 32 characters is required.");
        stickyMs = stickyMilliseconds;
        PiZones.Start();
        TcpListener listener = new TcpListener(IPAddress.Any, port);
        listener.Start();
        while (true)
        {
            TcpClient client = listener.AcceptTcpClient();
            Thread thread = new Thread(() => Serve(client, token));
            thread.IsBackground = true;
            thread.Start();
        }
    }
}
