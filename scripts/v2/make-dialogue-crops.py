"""Evaluation-only: make an ordered sheet of real OCR-region image crops.

This does not alter OCR text, remove source pixels, or produce translation output.
"""
import base64
import io
import json
import math
import sys
from PIL import Image, ImageDraw

request = json.loads(sys.stdin.buffer.read())
source = Image.open(io.BytesIO(base64.b64decode(request["imagePngBase64"], validate=True))).convert("RGB")
regions = request["regions"]
assert isinstance(regions, list) and 0 < len(regions) <= 128
columns = min(3, len(regions))
cell_width, cell_height = 420, 560
sheet = Image.new("RGB", (columns * cell_width, math.ceil(len(regions) / columns) * cell_height), "#dddddd")
draw = ImageDraw.Draw(sheet)
manifest = []
for index, region in enumerate(regions):
    box = region["bbox"]
    assert all(isinstance(box[k], (int, float)) and math.isfinite(box[k]) for k in ("x", "y", "width", "height"))
    x, y, width, height = (box[k] for k in ("x", "y", "width", "height"))
    assert 0 <= x < 1 and 0 <= y < 1 and 0 < width <= 1 and 0 < height <= 1
    padding = max(8, round(min(width * source.width, height * source.height) * 0.15))
    pixel_box = (max(0, math.floor(x * source.width) - padding), max(0, math.floor(y * source.height) - padding),
                 min(source.width, math.ceil((x + width) * source.width) + padding), min(source.height, math.ceil((y + height) * source.height) + padding))
    crop = source.crop(pixel_box)
    scale = min((cell_width - 24) / crop.width, (cell_height - 48) / crop.height)
    crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
    left, top = (index % columns) * cell_width, (index // columns) * cell_height
    draw.text((left + 12, top + 10), str(index + 1), fill="black")
    sheet.paste(crop, (left + (cell_width - crop.width) // 2, top + 36 + (cell_height - 48 - crop.height) // 2))
    manifest.append({"number": index + 1, "id": region["id"], "sourcePixelBox": pixel_box})
buffer = io.BytesIO()
sheet.save(buffer, format="PNG")
print(json.dumps({"version": 1, "sheetPngBase64": base64.b64encode(buffer.getvalue()).decode("ascii"), "regions": manifest}))
