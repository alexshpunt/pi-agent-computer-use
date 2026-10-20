# Transcribe a WAV file with faster-whisper on this machine and print JSON: {"text", "language", "segments"}.
# Run through uv so nothing is installed globally:
#   uv run -q --with faster-whisper --with "av<16" python scripts/transcribe.py <file.wav> [model]
# (av 16 dropped an argument faster-whisper still passes.)
# The default model is base.en; it is downloaded to the Hugging Face cache on first use.
import json
import sys

from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "base.en", device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1])
parts = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
print(json.dumps({"text": " ".join(p["text"] for p in parts), "language": info.language, "segments": parts}))
