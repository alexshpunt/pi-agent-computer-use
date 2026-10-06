"""Read-only MobileCLIP tile experiment; never capture or send desktop input.

Use --record-stdin to save exact computer_observe image bytes under .tmp.
Use --frames and --grid to classify a visually checked 4x4 grid. Scores are
similarities, not calibrated probabilities. Model weights are research-only.
"""
import argparse
import base64
import hashlib
import json
import statistics
import sys
import time
from pathlib import Path


def record(directory):
    data = json.load(sys.stdin)
    image = data.pop("image")
    raw = base64.b64decode(image["data"], validate=True)
    extension = {"image/png": "png", "image/jpeg": "jpg"}[image["mimeType"]]
    directory.mkdir(parents=True, exist_ok=True)
    index = len(list(directory.glob("capture-*.json")))
    name = f"capture-{index:03d}"
    (directory / f"{name}.{extension}").write_bytes(raw)
    data["sha256"] = hashlib.sha256(raw).hexdigest()
    (directory / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps({"frame": name, "sha256": data["sha256"]}))


def summarize(report, labels_path, frames_directory):
    """Compare pixel-reviewed labels with scores; keep all failures visible."""
    labels = json.loads(labels_path.read_text())
    confusion = dict(tp=0, tn=0, fp=0, fn=0)
    failures = []
    hashes = set()
    captures = []
    for row in report["frames"]:
        expected = set(labels[row["frame"]])
        predicted = set(row["mole_tiles"])
        for tile in range(1, 17):
            if tile in expected:
                key = "tp" if tile in predicted else "fn"
            else:
                key = "fp" if tile in predicted else "tn"
            confusion[key] += 1
        if expected != predicted:
            failures.append({"frame": row["frame"], "expected": sorted(expected), "predicted": sorted(predicted)})
        meta = json.loads((frames_directory / Path(row["frame"]).with_suffix(".json")).read_text())
        hashes.add(meta["sha256"])
        if meta["capture_ms"] is not None:
            captures.append(meta["capture_ms"])
    def distribution(values):
        if not values:
            return None
        ordered = sorted(values)
        return {"median": statistics.median(values), "p95": ordered[min(len(ordered)-1, int(len(ordered)*.95))]}
    summary = {key: value for key, value in report.items() if key != "frames"}
    summary.update({"frame_count": len(report["frames"]), "unique_image_hashes": len(hashes), "confusion": confusion, "failures": failures,
                    "capture_pair_ms": distribution(captures),
                    "preprocess_ms": distribution([r["preprocess_ms"] for r in report["frames"]]),
                    "transfer_ms": distribution([r["transfer_ms"] for r in report["frames"]])})
    return summary


def classify(args):
    import importlib.metadata
    import torch
    import open_clip
    from PIL import Image, ImageDraw
    from timm.utils import reparameterize_model

    torch.set_num_threads(4)
    if not torch.cuda.is_available():
        raise RuntimeError("This experiment requires the approved local GPU")
    started = time.perf_counter()
    model, _, preprocess = open_clip.create_model_and_transforms(args.model, pretrained="dfndr2b")
    model.eval()
    model = reparameterize_model(model).to("cuda")
    tokenizer = open_clip.get_tokenizer(args.model)
    torch.cuda.synchronize()
    load_ms = (time.perf_counter() - started) * 1000
    prompts = ["a cartoon mole animal popping out of green grass", "a patch of green grass with no animal"]
    with torch.inference_mode():
        started = time.perf_counter()
        text = model.encode_text(tokenizer(prompts).to("cuda"))
        text = text / text.norm(dim=-1, keepdim=True)
        torch.cuda.synchronize()
        text_ms = (time.perf_counter() - started) * 1000
        x, y, pitch, size = args.grid
        results = []
        timing = []
        frames = sorted(path for path in args.frames.glob("capture-*") if path.suffix in {".png", ".jpg"})
        if not frames:
            raise RuntimeError("No recorded frames")
        sheet = Image.new("RGB", (16 * 80, len(frames) * 100), "white")
        draw = ImageDraw.Draw(sheet)
        for row, path in enumerate(frames):
            source = Image.open(path).convert("RGB")
            boxes = [
                (round(x + c * pitch), round(y + r * pitch),
                 round(x + c * pitch + size), round(y + r * pitch + size))
                for r in range(4) for c in range(4)
            ]
            if any(a < 0 or b < 0 or c > source.width or d > source.height for a, b, c, d in boxes):
                raise ValueError(f"Grid outside {path.name}; inspect capture geometry")
            started = time.perf_counter()
            tiles = [source.crop(box) for box in boxes]
            batch = torch.stack([preprocess(tile) for tile in tiles])
            preprocess_ms = (time.perf_counter() - started) * 1000
            started = time.perf_counter()
            batch = batch.to("cuda")
            torch.cuda.synchronize()
            transfer_ms = (time.perf_counter() - started) * 1000
            for _ in range(3):
                with torch.autocast("cuda", enabled=args.precision == "fp16"):
                    model.encode_image(batch)
            torch.cuda.synchronize()
            samples = []
            for _ in range(args.repeats):
                started = time.perf_counter()
                with torch.autocast("cuda", enabled=args.precision == "fp16"):
                    features = model.encode_image(batch)
                features = features.float()
                features = features / features.norm(dim=-1, keepdim=True)
                scores = features @ text.T
                torch.cuda.synchronize()
                samples.append((time.perf_counter() - started) * 1000)
            cosines = scores.cpu().tolist()
            for col, tile in enumerate(tiles):
                sheet.paste(tile.resize((80, 80)), (col * 80, row * 100))
                margin = cosines[col][0] - cosines[col][1]
                draw.text((col * 80, row * 100 + 80), f"{col+1}: {margin:+.3f}", fill="black")
            timing.extend(samples)
            results.append({
                "frame": path.name, "cosines": cosines,
                "mole_tiles": [i + 1 for i, pair in enumerate(cosines) if pair[0] > pair[1]],
                "preprocess_ms": preprocess_ms, "transfer_ms": transfer_ms,
            })
        report = {
            "model": args.model, "precision": args.precision, "prompts": prompts,
            "grid": args.grid, "device": torch.cuda.get_device_name(),
            "versions": {name: importlib.metadata.version(name)
                         for name in ["torch", "open_clip_torch", "timm", "pillow"]},
            "load_ms": load_ms, "text_once_ms": text_ms,
            "batch_16_gpu_ms": {
                "median": statistics.median(timing),
                "p95": sorted(timing)[min(len(timing)-1, int(len(timing)*.95))],
            },
            "frames": results,
        }
        args.output.mkdir(parents=True, exist_ok=True)
        sheet.save(args.output / "contact.png")
        (args.output / "scores.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({k: v for k, v in report.items() if k != "frames"}))
        print(json.dumps([{"frame": r["frame"], "mole_tiles": r["mole_tiles"]} for r in results]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-stdin", type=Path)
    parser.add_argument("--assess", type=Path, help="Existing scores.json; no model run")
    parser.add_argument("--labels", type=Path, help="Pixel-reviewed positive tile numbers")
    parser.add_argument("--frames", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--model", default="MobileCLIP2-S0", choices=["MobileCLIP2-S0", "MobileCLIP2-S2"])
    parser.add_argument("--grid", nargs=4, type=float, metavar=("X", "Y", "PITCH", "SIZE"))
    parser.add_argument("--repeats", type=int, default=20)
    parser.add_argument("--precision", choices=["fp32", "fp16"], default="fp32")
    args = parser.parse_args()
    if args.record_stdin:
        record(args.record_stdin)
    elif args.assess and args.labels and args.frames and args.output:
        summary = summarize(json.loads(args.assess.read_text()), args.labels, args.frames)
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary))
    elif args.frames and args.output and args.grid and args.repeats > 0:
        classify(args)
    else:
        parser.error("Use --record-stdin or --frames, --output and --grid")
