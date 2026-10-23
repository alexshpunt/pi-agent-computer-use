# Record what the default playback device plays (WASAPI loopback) for a number of seconds into a 16-bit PCM WAV file.
# Usage: powershell -File audio-loopback.ps1 <seconds> <output.wav>
param([Parameter(Mandatory)][double]$Seconds, [Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class PiLoopback {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IntPtr devices); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object client); }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n); int GetChannelCount(out uint n);
    int SetMasterVolumeLevel(float l, ref Guid g); int SetMasterVolumeLevelScalar(float l, ref Guid g); int GetMasterVolumeLevel(out float l);
    int GetMasterVolumeLevelScalar(out float l); int SetChannelVolumeLevel(uint c, float l, ref Guid g); int SetChannelVolumeLevelScalar(uint c, float l, ref Guid g);
    int GetChannelVolumeLevel(uint c, out float l); int GetChannelVolumeLevelScalar(uint c, out float l); int SetMute(bool m, ref Guid g); int GetMute(out bool m);
  }
  [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
    int GetBufferSize(out uint frames); int GetStreamLatency(out long latency); int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest); int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod); int Start(); int Stop(); int Reset();
    int SetEventHandle(IntPtr handle); int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }
  [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long position, out long qpc);
    int ReleaseBuffer(uint frames); int GetNextPacketSize(out uint frames);
  }

  static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }

  /// Capture the default render endpoint's mix for the given time and write it as 16-bit PCM.
  public static void Record(double seconds, string path) {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice device; Check(enumerator.GetDefaultAudioEndpoint(0, 0, out device));
    // Some drivers feed loopback only silence while the endpoint is muted; refuse rather than record it.
    var volumeId = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object volumeObject;
    Check(device.Activate(ref volumeId, 23, IntPtr.Zero, out volumeObject));
    bool muted; Check(((IAudioEndpointVolume)volumeObject).GetMute(out muted));
    if (muted) throw new InvalidOperationException("The default playback device is muted; loopback would record only silence.");
    var clientId = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"); object clientObject;
    Check(device.Activate(ref clientId, 23, IntPtr.Zero, out clientObject));
    var client = (IAudioClient)clientObject;
    IntPtr format; Check(client.GetMixFormat(out format));
    int channels = Marshal.ReadInt16(format, 2), rate = Marshal.ReadInt32(format, 4), bits = Marshal.ReadInt16(format, 14);
    short tag = Marshal.ReadInt16(format, 0);
    bool isFloat = tag == 3 || (tag == unchecked((short)0xFFFE) && bits == 32);
    Check(client.Initialize(0, 0x00020000, 10000000, 0, format, IntPtr.Zero)); // shared, loopback, 1 s buffer
    var captureId = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"); object captureObject;
    Check(client.GetService(ref captureId, out captureObject));
    var capture = (IAudioCaptureClient)captureObject;
    var pcm = new MemoryStream();
    var writer = new BinaryWriter(pcm);
    int bytesPerSample = bits / 8, frameBytes = bytesPerSample * channels;
    var deadline = DateTime.UtcNow.AddSeconds(seconds);
    var started = DateTime.UtcNow; long framesWritten = 0;
    Check(client.Start());
    try {
      while (DateTime.UtcNow < deadline) {
        Thread.Sleep(10);
        uint packet; Check(capture.GetNextPacketSize(out packet));
        while (packet > 0) {
          IntPtr data; uint frames, flags; long position, qpc;
          Check(capture.GetBuffer(out data, out frames, out flags, out position, out qpc));
          var buffer = new byte[frames * frameBytes];
          if ((flags & 2) == 0) Marshal.Copy(data, buffer, 0, buffer.Length); // 2 = silent
          for (int i = 0; i < frames * channels; i++) {
            float sample = isFloat ? BitConverter.ToSingle(buffer, i * 4) : BitConverter.ToInt16(buffer, i * 2) / 32768f;
            writer.Write((short)Math.Max(-32768, Math.Min(32767, sample * 32767)));
          }
          framesWritten += frames;
          Check(capture.ReleaseBuffer(frames));
          Check(capture.GetNextPacketSize(out packet));
        }
        // Loopback delivers nothing while nothing plays; keep the timeline with silence.
        long expected = (long)((DateTime.UtcNow - started).TotalSeconds * rate);
        for (; framesWritten < expected - rate / 10; framesWritten++) for (int c = 0; c < channels; c++) writer.Write((short)0);
      }
    } finally { client.Stop(); Marshal.FreeCoTaskMem(format); }
    writer.Flush();
    using (var file = new BinaryWriter(File.Create(path))) {
      int dataLength = (int)pcm.Length;
      file.Write(new[] { 'R', 'I', 'F', 'F' }); file.Write(36 + dataLength); file.Write(new[] { 'W', 'A', 'V', 'E' });
      file.Write(new[] { 'f', 'm', 't', ' ' }); file.Write(16); file.Write((short)1); file.Write((short)channels);
      file.Write(rate); file.Write(rate * channels * 2); file.Write((short)(channels * 2)); file.Write((short)16);
      file.Write(new[] { 'd', 'a', 't', 'a' }); file.Write(dataLength); pcm.WriteTo(file.BaseStream);
    }
  }
}
'@
[PiLoopback]::Record($Seconds, $Path)
