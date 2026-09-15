# Demo film

Same pipeline as the Whop Desktop demo videos: the real app captured with a cursor, composited over a dark Apple wallpaper with a rounded window and a caption line. No audio.

```bash
# 1. demo server (dry run, no Whop calls)
PORT=8797 DRY_RUN=1 npm start
# 2. record 23 s at 30 fps as PNG frames (puppeteer is linked from a sibling project; npm i puppeteer here also works)
cd film && node capture.mjs
# 3. composite + encode
python3 composite.py <frames_dir> assets/wallpaper.png out/curfew-demo.mp4
```

Captions live in `composite.py`; cursor, scroll and action timings in `capture.mjs`. Keep the two in sync.
