#!/usr/bin/env python3
"""Measuring aids for painting a reference: a copy at canvas size, a grid copy, a flat-colour copy and a palette.

Usage: python3 prepare_reference.py reference.png 1200x800 [out_dir]

Writes to out_dir (default: ref/):
  ref.png       the reference resized to the canvas: its pixel coordinates are canvas coordinates
  ref-grid.png  ref.png with a line every 50 px and labels every 100 px
  ref-flat.png  ref.png reduced to the palette colours: shows the big colour areas to block in
  palette.txt   the palette: hex colour, share of the picture and where it is mostly found
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

COLOURS = 14


def main() -> None:
    source = Path(sys.argv[1])
    width, height = (int(v) for v in sys.argv[2].lower().split("x"))
    out = Path(sys.argv[3] if len(sys.argv) > 3 else "ref")
    out.mkdir(parents=True, exist_ok=True)

    ref = Image.open(source).convert("RGB").resize((width, height), Image.LANCZOS)
    ref.save(out / "ref.png")

    grid = ref.copy()
    draw = ImageDraw.Draw(grid)
    for x in range(0, width, 50):
        draw.line([(x, 0), (x, height)], fill=(255, 0, 255) if x % 100 == 0 else (255, 160, 255), width=1)
    for y in range(0, height, 50):
        draw.line([(0, y), (width, y)], fill=(255, 0, 255) if y % 100 == 0 else (255, 160, 255), width=1)
    for x in range(0, width, 100):
        for y in range(0, height, 100):
            draw.text((x + 3, y + 2), f"{x},{y}", fill=(160, 0, 160))
    grid.save(out / "ref-grid.png")

    # A light blur first, so hatching and paper texture merge into the areas they shade. Many candidate colours,
    # then near-duplicates merged, so small accents such as an orange highlight keep their own entry.
    soft = ref.filter(ImageFilter.GaussianBlur(2))
    candidates = soft.quantize(colors=48, method=Image.Quantize.MEDIANCUT)
    raw = candidates.getpalette()[: 48 * 3]
    counts = sorted(((n, i) for n, i in candidates.getcolors(48 * 48)), reverse=True)
    chosen: list[list[int]] = []  # [r, g, b, count]
    for count, index in counts:
        colour = raw[index * 3: index * 3 + 3]
        near = next((c for c in chosen if sum((a - b) ** 2 for a, b in zip(c[:3], colour)) < 28 ** 2), None)
        if near:
            near[3] += count
        elif len(chosen) < COLOURS:
            chosen.append([*colour, count])
    palette_image = Image.new("P", (1, 1))
    palette_image.putpalette([v for c in chosen for v in c[:3]] + [0] * (768 - 3 * len(chosen)))
    flat = soft.quantize(palette=palette_image, dither=Image.Dither.NONE)
    flat.convert("RGB").save(out / "ref-flat.png")

    pixels = flat.load()
    count = [0] * len(chosen)
    sums = [[0, 0] for _ in chosen]
    for y in range(0, height, 2):
        for x in range(0, width, 2):
            index = pixels[x, y]
            if index < len(chosen):
                count[index] += 1
                sums[index][0] += x
                sums[index][1] += y
    total = sum(count)
    lines = []
    for index in sorted(range(len(chosen)), key=lambda i: -count[i]):
        if not count[index]:
            continue
        r, g, b = chosen[index][:3]
        cx, cy = sums[index][0] // count[index], sums[index][1] // count[index]
        lines.append(f"#{r:02x}{g:02x}{b:02x}  {100 * count[index] / total:5.1f}%  centre of mass {cx},{cy}")
    (out / "palette.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"Wrote {out}/ref.png, ref-grid.png, ref-flat.png and palette.txt at {width}x{height}.")


if __name__ == "__main__":
    main()
