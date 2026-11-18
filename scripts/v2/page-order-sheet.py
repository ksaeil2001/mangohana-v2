"""Read-only input contact sheet for checking original page order; never changes pages."""
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw, ImageFont
import sys

source, target = map(Path, sys.argv[1:3])
files = sorted(source.glob('*.png'))[:10]
sheet = Image.new('RGB', (1250, 790), '#252525')
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default(size=24)
for index, file in enumerate(files):
    x, y = index % 5 * 250, index // 5 * 395
    draw.text((x + 12, y + 5), file.name.split('-')[0], fill='white', font=font)
    with Image.open(file) as image:
        thumb = ImageOps.contain(image.convert('RGB'), (238, 350))
        sheet.paste(thumb, (x + (250 - thumb.width) // 2, y + 38))
with target.open('xb') as output:
    sheet.save(output, format='JPEG', quality=90)
print(target)
