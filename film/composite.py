"""Composite captured dashboard frames over the wallpaper with a rounded window,
soft shadow, and a caption line, matching the Whop Desktop demo videos. Then encode.
usage: python3 composite.py <frames_dir> <wallpaper.png> <out.mp4>"""
import sys, subprocess, glob, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

frames_dir, wallpaper, out = sys.argv[1:4]
NO_CAPTIONS = '--no-captions' in sys.argv
FPS = 30
W, H = 1920, 1080
WIN = (222, 48)            # window top-left, measured from the reference
RADIUS = 12
FONT = os.path.expanduser('~/Library/Fonts/Inter-VariableFont_opsz,wght.ttf')

# captions: (start, end, text). Times match film/capture.mjs.
CAPTIONS = [
    (0.0, 3.0, 'Curfew learns what normal looks like for your shop.'),
    (3.4, 8.6, '3:12 AM. Eighty attempts in eight minutes.'),
    (8.8, 11.4, 'It knows why. Six signals, in plain numbers.'),
    (11.8, 14.8, 'Every payment scored and explained.'),
    (15.2, 18.0, 'Held. Refund and revoke in ten minutes, unless you say it’s legit.'),
    (18.4, 20.8, 'Refunded and revoked. You were asleep.'),
    (21.0, 23.0, 'Curfew. A fraud layer for Whop.'),
]

bg = Image.open(wallpaper).convert('RGB').resize((W, H), Image.LANCZOS)
# calm the ground: soften and darken so the window carries the frame
from PIL import ImageEnhance
bg = ImageEnhance.Brightness(bg.filter(ImageFilter.GaussianBlur(10))).enhance(0.45)
font = ImageFont.truetype(FONT, 36)
try: font.set_variation_by_axes([36, 400])
except Exception: pass

files = sorted(glob.glob(os.path.join(frames_dir, '*.png')))
first = Image.open(files[0]); ww, wh = first.size
mask = Image.new('L', (ww, wh), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, ww - 1, wh - 1), radius=RADIUS, fill=255)
# shadow: blurred black rounded rect behind the window
shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle((WIN[0] - 2, WIN[1] + 18, WIN[0] + ww + 2, WIN[1] + wh + 26), radius=RADIUS + 4, fill=(0, 0, 0, 150))
shadow = shadow.filter(ImageFilter.GaussianBlur(28))
base = bg.convert('RGBA'); base.alpha_composite(shadow)

proc = subprocess.Popen(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                         '-an', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', '-movflags', '+faststart', out], stdin=subprocess.PIPE)
for i, f in enumerate(files):
    t = i / FPS
    im = base.copy()
    win = Image.open(f).convert('RGB')
    im.paste(win, WIN, mask)
    d = ImageDraw.Draw(im)
    for a, b, text in ([] if NO_CAPTIONS else CAPTIONS):
        if a <= t < b:
            # 0.25 s fade in/out
            k = min(1, (t - a) / 0.25, (b - t) / 0.25)
            tw = d.textlength(text, font=font)
            d.text(((W - tw) / 2, 1010), text, font=font, fill=(255, 255, 255, int(255 * max(0, k))))
    proc.stdin.write(im.convert('RGB').tobytes())
    if i % 90 == 0: print(f'composited {i}/{len(files)}')
proc.stdin.close(); assert proc.wait() == 0
print('wrote', out)
