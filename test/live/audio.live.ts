import { afterAll, expect, test } from "vitest";
import { connectLive, text } from "./remote.ts";

// LPT-819: playback audio on the machine is recorded through WASAPI loopback and transcribed on this machine.
// The machine needs an active playback device; the phrase is spoken aloud there for a few seconds.
const live = await connectLive();
afterAll(() => live.close());

test("speech played on the machine is recorded and transcribed with its words", async () => {
  const phrase = "The quick brown fox jumps over the lazy dog. Computer use can hear sound now.";
  const speaking = live.powershell(`Start-Sleep -Milliseconds 800; Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${phrase}')`).catch(error => error); // Without a device the recorder explains the failure.
  const recorded = await live.insert(live.machine, { action: "audio_record", seconds: 9, transcribe: true, to: ".tmp/audio-test.wav" });
  await speaking;
  expect(recorded.details.status, text(recorded)).toBe("delivered");
  const transcript = (recorded.details.state!.transcript as { text: string }).text.toLowerCase();
  console.log("transcript", transcript);
  for (const word of ["quick", "brown", "fox", "lazy", "dog", "computer", "hear", "sound"]) expect(transcript).toContain(word);
});
