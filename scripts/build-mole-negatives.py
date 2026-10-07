"""Build private controlled negative tiles from the verified saved grass frames.

No screen capture, game input or external images. The last four tiles are
unchanged positive crops. Review contact.png before classifying this dataset.
"""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw


def crop(directory, frame, tile):
    """Copy one tile from the previously checked detail-image grid."""
    row, column = divmod(tile - 1, 4)
    x, y = round(72 + column * 89.5), round(73 + row * 89.5)
    return Image.open(directory / frame).convert("RGB").crop((x, y, x + 86, y + 86))


def build(args):
    """Save a reproducible private board, labels and a labelled review sheet."""
    dataset = json.loads(args.dataset.read_text())
    for row in dataset["frames"]:
        raw = (args.frames / row["frame"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise ValueError(f"Changed source frame: {row['frame']}")
    grass = crop(args.frames, "capture-003.jpg", 1)
    names = ["plain grass", "plain grass 2", "soil patch", "empty dark hole",
             "wooden log", "cut tree stump", "brown square", "orange ball",
             "grey stone", "red flower", "small tree", "purple badge"]
    tiles = []
    for name in names:
        tile = grass.copy()
        draw = ImageDraw.Draw(tile)
        if name == "plain grass 2":
            tile = crop(args.frames, "capture-003.jpg", 16)
        elif name == "soil patch":
            draw.ellipse((14, 42, 73, 67), fill="#704424")
        elif name == "empty dark hole":
            draw.ellipse((14, 40, 73, 67), fill="#683a20")
            draw.ellipse((19, 44, 68, 62), fill="#15100c")
        elif name == "wooden log":
            draw.rectangle((16, 38, 62, 61), fill="#80502d", outline="#442618", width=2)
            draw.ellipse((55, 38, 75, 61), fill="#c69b63", outline="#442618", width=2)
            draw.ellipse((61, 43, 69, 56), outline="#80502d", width=2)
            draw.line((20, 43, 53, 43), fill="#b0834f", width=2)
        elif name == "cut tree stump":
            draw.rectangle((29, 40, 59, 67), fill="#74482c")
            draw.ellipse((25, 29, 63, 49), fill="#c69b63", outline="#442618", width=2)
            draw.ellipse((33, 33, 55, 45), outline="#80502d", width=2)
        elif name == "brown square":
            draw.rectangle((25, 25, 62, 63), fill="#a46436", outline="#60391f", width=2)
        elif name == "orange ball":
            draw.ellipse((24, 24, 64, 64), fill="#ea8c22", outline="#a35117", width=2)
            draw.arc((25, 25, 63, 63), 210, 280, fill="#ffd587", width=3)
        elif name == "grey stone":
            draw.polygon([(17, 60), (29, 35), (56, 31), (72, 58), (55, 68)], fill="#92928c")
            draw.line((29, 35, 48, 49, 56, 31), fill="#c0c0b9", width=2)
        elif name == "red flower":
            draw.line((43, 39, 43, 70), fill="#225c29", width=4)
            for box in [(28, 26, 46, 44), (40, 26, 58, 44), (34, 16, 52, 34), (34, 36, 52, 54)]:
                draw.ellipse(box, fill="#df3447")
            draw.ellipse((37, 29, 49, 41), fill="#f6d341")
        elif name == "small tree":
            draw.rectangle((38, 38, 49, 73), fill="#80502d")
            draw.ellipse((17, 11, 70, 53), fill="#24783a", outline="#17572a", width=2)
        elif name == "purple badge":
            draw.rounded_rectangle((21, 25, 66, 63), radius=8, fill="#7d46bc")
            draw.line((30, 44, 40, 53, 58, 34), fill="white", width=4)
        tiles.append(tile)
    controls = [("capture-000.jpg", 2), ("capture-011.jpg", 14),
                ("capture-016.jpg", 16), ("capture-018.jpg", 6)]
    tiles.extend(crop(args.frames, frame, tile) for frame, tile in controls)
    names.extend(["mole control 1", "mole control 2", "tiny mole control 1", "tiny mole control 2"])
    board = Image.new("RGB", (500, 503), "white")
    sheet = Image.new("RGB", (4 * 172, 4 * 200), "white")
    labels = ImageDraw.Draw(sheet)
    for i, tile in enumerate(tiles):
        row, column = divmod(i, 4)
        board.paste(tile, (round(72 + column * 89.5), round(73 + row * 89.5)))
        sheet.paste(tile.resize((172, 172)), (column * 172, row * 200))
        labels.text((column * 172 + 4, row * 200 + 175), f"{i+1}: {names[i]}", fill="black")
    args.output.mkdir(parents=True, exist_ok=True)
    board.save(args.output / "capture-000.png")
    sheet.save(args.output / "contact.png")
    sha = hashlib.sha256((args.output / "capture-000.png").read_bytes()).hexdigest()
    (args.output / "capture-000.json").write_text(json.dumps({"sha256": sha, "capture_ms": None}, indent=2) + "\n")
    (args.output / "labels.json").write_text(json.dumps({"capture-000.png": [13, 14, 15, 16]}, indent=2) + "\n")
    manifest = {"frame": "capture-000.png", "sha256": sha, "synthetic": True,
                "tile_names": names, "positive_tiles": [13, 14, 15, 16],
                "source_dataset": "docs/evidence/mole-classifier/dataset.json", "positive_crop_sources": controls}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, default=Path("docs/evidence/mole-classifier/dataset.json"))
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args())
