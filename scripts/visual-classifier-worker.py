"""Owned offline TinyCLIP-39M worker. One text condition; no competing labels or capture."""
import base64
from collections import OrderedDict
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import time

# stdout is a bounded JSON-lines protocol, not a library progress stream.
protocol = sys.stdout
sys.stdout = sys.stderr
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
PINNED = {
    "model.safetensors": "112bdfb07ebc8994e9afba7a2a314e278493a675033595cf48e54cf8a17ae587",
    "config.json": "de47e9e12875c7abb6e0ddd13b5b0f54851b96cefa5c2ed3aab881e3efd1647b",
    "preprocessor_config.json": "910e70b3956ac9879ebc90b22fb3bc8a75b6a0677814500101a4c072bd7857bd",
    "tokenizer.json": "b556ac8c99757ffb677208af34bc8c6721572114111a6e0aaf5fa69ff0b8d842",
}
model = processor = torch = None
cache = OrderedDict()


def load():
    """Load only the reviewed local artifact. Never fetch weights or execute model code."""
    global model, processor, torch
    root = Path(sys.argv[1])
    for name, expected in PINNED.items():
        with (root / name).open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                raise ValueError("Local TinyCLIP artifact does not match the qualified pin.")
    # Avoid an extra processor/tokenizer config silently changing the pinned tokenizer.
    extra = {"tokenizer_config.json", "special_tokens_map.json", "processor_config.json"}
    if any((root / name).exists() for name in extra):
        raise ValueError("Use the qualified TinyCLIP snapshot without extra processor configs.")
    import torch as torch_module
    from transformers import AutoModel, AutoProcessor
    torch = torch_module
    torch.set_num_threads(4)
    if not torch.cuda.is_available():
        raise ValueError("The qualified classifier requires the local CUDA runtime.")
    loaded = AutoModel.from_pretrained(root, local_files_only=True, trust_remote_code=False,
                                      use_safetensors=True, attn_implementation="sdpa").eval().to("cuda")
    processed = AutoProcessor.from_pretrained(root, local_files_only=True, trust_remote_code=False)
    model, processor = loaded, processed


def classify(request):
    """Return raw normalized cosine and cache/timing evidence, not a probability."""
    start = time.perf_counter()
    load_ms = 0
    if model is None:
        load()
        load_ms = (time.perf_counter() - start) * 1000
    condition = request["condition"]
    if not isinstance(condition, str) or not condition.strip() or len(condition) > 2048:
        raise ValueError("Provide one nonempty visual condition.")
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 16_000_000
    data = base64.b64decode(request["data"], validate=True)
    if not 0 < len(data) <= 10 * 1024 * 1024:
        raise ValueError("Image byte bound exceeded.")
    with Image.open(io.BytesIO(data)) as source:
        if source.width * source.height > 16_000_000 or getattr(source, "n_frames", 1) != 1:
            raise ValueError("Use one bounded image frame.")
        image = ImageOps.exif_transpose(source).convert("RGB")
    start = time.perf_counter()
    hit = condition in cache
    with torch.inference_mode():
        if hit:
            text = cache[condition]
            cache.move_to_end(condition)
        else:
            tokens = processor(text=[condition], padding=True, truncation=False, return_tensors="pt")
            if tokens["input_ids"].shape[-1] > model.config.text_config.max_position_embeddings:
                raise ValueError("Condition exceeds the model token limit; it was not truncated.")
            text = model.get_text_features(**tokens.to("cuda"), return_dict=True).pooler_output.float()
            text /= text.norm(dim=-1, keepdim=True)
            cache[condition] = text
            if len(cache) > 128:
                cache.popitem(last=False)
        pixels = processor(images=[image], return_tensors="pt")["pixel_values"].to("cuda")
        with torch.autocast("cuda", dtype=torch.float16):
            features = model.get_image_features(pixel_values=pixels, return_dict=True).pooler_output
        features = features.float()
        features /= features.norm(dim=-1, keepdim=True)
        score = (features @ text.T).item()
    return {"score": score, "cache_hit": hit, "load_ms": load_ms,
            "inference_ms": (time.perf_counter() - start) * 1000}


while True:
    line = sys.stdin.readline(14 * 1024 * 1024 + 1)
    if not line:
        break
    request = {}
    try:
        if len(line) > 14 * 1024 * 1024 or not line.endswith("\n"):
            raise ValueError("Worker input bound exceeded.")
        request = json.loads(line)
        result = classify(request)
    except Exception as error:
        result = {"error": str(error)[:512]}
    protocol.write(json.dumps({"id": request.get("id"), **result}, allow_nan=False) + "\n")
    protocol.flush()
