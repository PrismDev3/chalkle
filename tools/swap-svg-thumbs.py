#!/usr/bin/env python3
# swap-svg-thumbs.py - Replace generated SVG thumbs in src/games.js with real
# captured screenshots from assets/games/real/<slug>.jpg for /ugs/<slug>.html
# entries. Idempotent: re-running only replaces remaining SVG thumbs.
import re, os, json, sys

SRC = 'src/games.js'
REAL_DIR = 'assets/games/real'
MIN_BYTES = 16000

s = open(SRC, encoding='utf-8', errors='replace').read()
parts = re.split(r'(?=\{\s*title:)', s)

replaced = 0
kept_svg = []
by_file = {}

for i, p in enumerate(parts):
    if '"data:image/svg' not in p:
        continue
    m = re.search(r'url:\s*"([^"]*)"', p)
    url = m.group(1) if m else ''
    slug = url.split('/')[-1].replace('.html', '') if url.startswith('/ugs/') else None
    real = None
    if slug:
        fp = os.path.join(REAL_DIR, slug + '.jpg')
        if os.path.exists(fp) and os.path.getsize(fp) >= MIN_BYTES:
            real = '/assets/games/real/' + slug + '.jpg'
    if real:
        newp = re.sub(r'thumb:\s*"data:image/svg[^"]*"', 'thumb: "' + real + '"', p, count=1)
        parts[i] = newp
        replaced += 1
    else:
        t = re.search(r'title:\s*"([^"]*)"', p)
        kept_svg.append((slug, t.group(1) if t else url))

open(SRC, 'w', encoding='utf-8', newline='').write(''.join(parts))

# report
state = {'replaced': replaced, 'remaining_svg': len(kept_svg), 'remaining': kept_svg}
open('tmp-svg-swap-report.json', 'w').write(json.dumps(state, indent=1))
print(f'replaced {replaced} SVG thumbs with real screenshots')
print(f'remaining SVG thumbs: {len(kept_svg)}')
for slug, t in kept_svg[:60]:
    print('  ', (slug or '?'), '|', t)
