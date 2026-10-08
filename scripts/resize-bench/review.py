"""Make numbered contact sheets without resizing the benchmark outputs.

Usage: python review.py RUN_DIRECTORY
Needs Pillow. This helper is not part of the timed benchmark.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

folder = Path(sys.argv[1])
report = json.loads((folder / 'run.json').read_text())
rows = report['rows']
width, height = report['output_dimensions']
for start in range(0, len(rows), 12):
    page = rows[start:start + 12]
    sheet = Image.new('RGB', (width * 4, (height + 28) * 3), 'white')
    draw = ImageDraw.Draw(sheet)
    for slot, row in enumerate(page):
        x, y = (slot % 4) * width, (slot // 4) * (height + 28)
        with Image.open(folder / (row['method'] + '.png')) as picture:
            assert picture.size == (width, height)
            sheet.paste(picture, (x, y + 28))
        draw.text((x + 4, y + 5), f"{start + slot + 1}: {row['method']} {row['median_ms']:.3f} ms", fill='black')
    sheet.save(folder / f'review-{start // 12 + 1}.png')
# A shareable comparison: remove the browser toolbar and its local address.
selected = ['fast-Nearest', 'pic-Spline16', 'fast-Bilinear', 'image-Lanczos3']
comparison = Image.new('RGB', (width * len(selected), height - 50 + 28), 'white')
labels = ImageDraw.Draw(comparison)
for slot, name in enumerate(selected):
    x = slot * width
    with Image.open(folder / (name + '.png')) as picture:
        comparison.paste(picture.crop((0, 50, width, height)), (x, 28))
    labels.text((x + 4, 5), name, fill='black')
comparison.save(folder / 'comparison.png')
print(json.dumps({'pages': (len(rows) + 11) // 12, 'methods': len(rows)}))
