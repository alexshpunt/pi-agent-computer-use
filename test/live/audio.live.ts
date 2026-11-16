import { afterAll, expect, test } from "vitest";
import { connectLive, text } from "./remote.ts";

// LPT-819: playback audio on the machine is recorded through WASAPI loopback and transcribed on this machine.
// The machine needs an active playback device; the phrase is spoken aloud there for a few seconds.
const live = await connectLive();
afterAll(() => live.close());

test("speech played on the machine is recorded and transcribed with its words", async context => {
  // Query the same default render endpoint WASAPI uses, independently of the recorder's result.
  const endpoint = Number((await live.powershell(`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PlaybackProbe {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Devices { [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IntPtr device); }
  public static int DefaultRender() {
    var enumerator = new Enumerator(); IntPtr device;
    try { int hr = ((Devices)enumerator).GetDefaultAudioEndpoint(0, 0, out device); if (device != IntPtr.Zero) Marshal.Release(device); return hr; }
    finally { Marshal.ReleaseComObject(enumerator); }
  }
}
'@; [PlaybackProbe]::DefaultRender()`)).trim());
  if (endpoint === -2147023728) context.skip("No active default playback endpoint on this machine (WASAPI E_NOTFOUND).");
  expect(endpoint).toBe(0);
  const phrase = "The quick brown fox jumps over the lazy dog. Computer use can hear sound now.";
  const speaking = live.powershell(`Start-Sleep -Milliseconds 800; Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${phrase}')`).catch(error => error);
  const recorded = await live.insert(live.machine, { action: "audio_record", seconds: 9, transcribe: true, to: ".tmp/audio-test.wav" });
  await speaking;
  expect(recorded.details.status, text(recorded)).toBe("delivered");
  const transcript = (recorded.details.state!.transcript as { text: string }).text.toLowerCase();
  console.log("transcript", transcript);
  for (const word of ["quick", "brown", "fox", "lazy", "dog", "computer", "hear", "sound"]) expect(transcript).toContain(word);
});
