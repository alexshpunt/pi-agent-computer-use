#!/usr/bin/env python3
"""Compare a snapshot of the canvas with the reference and list where they differ most.

Usage: python3 compare.py ref/ref.png snapshot.png [cell] [out.png]

Both images are blurred a little and compared in cells (default 50 px). Prints the overall difference, then the
cells that differ most with the reference's and the canvas's mean colour, merged into regions where neighbours
differ too. Writes out.png (default compare.png): the reference, the canvas and a heat map side by side at half size.
"""
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat


def mean(image: Image.Image, box: tuple[int, int, int, int]) -> tuple[int, int, int]:
    return tuple(int(v) for v in ImageStat.Stat(image.crop(box)).mean[:3])


def main() -> None:
    ref = Image.open(sys.argv[1]).convert("RGB")
    snap = Image.open(sys.argv[2]).convert("RGB")
    cell = int(sys.argv[3]) if len(sys.argv) > 3 else 50
    out = sys.argv[4] if len(sys.argv) > 4 else "compare.png"
    if snap.size != ref.size:
        print(f"Note: snapshot is {snap.size[0]}x{snap.size[1]}, reference {ref.size[0]}x{ref.size[1]}; the snapshot is resized.")
        snap = snap.resize(ref.size, Image.LANCZOS)
    width, height = ref.size
    soft_ref = ref.filter(ImageFilter.GaussianBlur(4))
    soft_snap = snap.filter(ImageFilter.GaussianBlur(4))
    diff = ImageChops.difference(soft_ref, soft_snap).convert("L")

    cells = []
    for y in range(0, height, cell):
        for x in range(0, width, cell):
            box = (x, y, min(x + cell, width), min(y + cell, height))
            cells.append((ImageStat.Stat(diff.crop(box)).mean[0], box))
    overall = sum(score for score, _ in cells) / len(cells)
    print(f"Mean difference {overall:.1f} (0 = identical, above 40 = very different). Cell {cell} px.")
    print("Worst cells: box x0,y0-x1,y1  difference  reference colour -> canvas colour")
    for score, box in sorted(cells, key=lambda c: -c[0])[:12]:
        r = mean(soft_ref, box)
        s = mean(soft_snap, box)
        print(f"  {box[0]},{box[1]}-{box[2]},{box[3]}  {score:5.1f}  #{r[0]:02x}{r[1]:02x}{r[2]:02x} -> #{s[0]:02x}{s[1]:02x}{s[2]:02x}")

    heat = Image.new("RGB", ref.size)
    draw = ImageDraw.Draw(heat)
    for score, box in cells:
        level = min(255, int(score * 4))
        draw.rectangle(box, fill=(level, 0, 255 - level))
    heat = Image.blend(snap, heat, 0.55)
    sheet = Image.new("RGB", (width * 3 // 2, height // 2), "white")
    for index, image in enumerate((ref, snap, heat)):
        sheet.paste(image.resize((width // 2, height // 2)), (index * width // 2, 0))
    sheet.save(out)
    print(f"Wrote {out}: reference | canvas | heat map (red = most different).")


if __name__ == "__main__":
    main()
