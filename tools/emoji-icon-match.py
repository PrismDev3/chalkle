"""Match UI chrome emojis in chat.html to pixel icons.

Renders each emoji into a canvas in headless Chrome (real alpha), then
compares against every PNG in both packs. Both sides are normalized:
cropped to the alpha bounding box and rescaled onto a shared grid, so
glyph position/size inside the frame cannot skew the ranking. Prefers
named files (via exact pixel-hash) when the winning numbered file is one
of them. Saves tools/icon-map.json.
"""
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NAMED = r"C:/Users/zeqrY/Downloads/emojis(1)"
NUM = r"C:/Users/zeqrY/Downloads/Emojis_Free/Emojis_16x16_Free"
DBG = 9236
CHROME = r"C:/Program Files/Google/Chrome/Application/chrome.exe"
GRID = 14  # normalized comparison grid

EMOJIS = [
    "\u2715", "\u26A0", "\u2615", "\U0001F4CC", "\u2709", "\U0001F5D1",
    "\u270F", "\u2713", "\U0001F464", "\U0001F465", "\U0001F4CE",
    "\U0001F4A1", "\U0001F4E1", "\U0001F514", "\U0001F517", "\U0001F507",
    "\U0001F50D", "\U0001F3E0", "\U0001F575", "\U0001F4AC", "\U0001F515",
    "\u2699", "\U0001F4E3", "\U0001F3A8", "\U0001F389", "\U0001F4E2",
    "\U0001F6E1", "\U0001F512", "\U0001F4BE", "\U0001F91D", "\U0001F550",
    "\U0001F6AB", "\U0001F44B", "\u2728", "\U0001F525", "\u2764",
    "\U0001F44D", "\U0001F44E", "\U0001F602",
]


def png_pixels(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, w, h, bitd, ctype = 8, 0, 0, 0, 0
    idat = b""
    plte = None
    trns = None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bitd, ctype = struct.unpack(">IIBB", chunk[:10])
        elif typ == b"PLTE":
            plte = chunk
        elif typ == b"tRNS":
            trns = chunk
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    if bitd != 8 or ctype not in (0, 2, 3, 6):
        return None
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 6: 4}[ctype]
    stride = w * ch
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        prev = line
        for x in range(w):
            o = (y * w + x) * 4
            if ctype == 2:
                out[o:o + 3] = line[x * 3:x * 3 + 3]; out[o + 3] = 255
            elif ctype == 6:
                out[o:o + 4] = line[x * 4:x * 4 + 4]
            elif ctype == 0:
                g = line[x]; out[o:o + 3] = bytes([g, g, g]); out[o + 3] = 255
            elif ctype == 3:
                idx = line[x]
                out[o:o + 3] = plte[idx * 3:idx * 3 + 3]
                out[o + 3] = trns[idx] if (trns and idx < len(trns)) else 255
    return w, h, bytes(out)


def alpha_bbox(pix, w, h):
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if pix[(y * w + x) * 4 + 3] > 25:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return None
    return minx, miny, maxx, maxy


def normalize(pix, w, h):
    """Crop to alpha bbox and rescale (area-average) onto GRID x GRID."""
    bb = alpha_bbox(pix, w, h)
    if not bb:
        return None
    x0, y0, x1, y1 = bb
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    out = bytearray(GRID * GRID * 4)
    for gy in range(GRID):
        for gx in range(GRID):
            sx0 = x0 + gx * bw // GRID
            sx1 = max(sx0 + 1, x0 + (gx + 1) * bw // GRID)
            sy0 = y0 + gy * bh // GRID
            sy1 = max(sy0 + 1, y0 + (gy + 1) * bh // GRID)
            r = g = b = a = n = 0
            for sy in range(sy0, min(sy1, y0 + bh)):
                for sx in range(sx0, min(sx1, x0 + bw)):
                    o = (sy * w + sx) * 4
                    pa = pix[o + 3]
                    r += pix[o] * pa; g += pix[o + 1] * pa; b += pix[o + 2] * pa
                    a += pa; n += 1
            o = (gy * GRID + gx) * 4
            if a:
                out[o] = r // a; out[o + 1] = g // a; out[o + 2] = b // a
                out[o + 3] = a // n
    return bytes(out)


def distance(a, b):
    d = 0
    for i in range(0, len(a), 4):
        aa = a[i + 3] / 255.0
        ab = b[i + 3] / 255.0
        d += abs(aa - ab) * 255
        w = max(aa, ab)
        if w > 0.05:
            for c in range(3):
                d += abs(a[i + c] - b[i + c]) * w
    return d


def main():
    icons = {}
    for f in os.listdir(NUM):
        if f.endswith(".png"):
            r = png_pixels(os.path.join(NUM, f))
            if r and r[0] == 16 and r[1] == 16:
                n = normalize(r[2], 16, 16)
                if n:
                    icons[f] = n
    print("icons normalized:", len(icons))

    named_by_hash = {}
    for f in os.listdir(NAMED):
        if f.endswith(".png"):
            r = png_pixels(os.path.join(NAMED, f))
            if r and r[0] == 16 and r[1] == 16:
                named_by_hash[hash(r[2])] = f

    profile = tempfile.mkdtemp(prefix="emo-canvas-")
    proc = subprocess.Popen([
        CHROME, f"--remote-debugging-port={DBG}", f"--user-data-dir={profile}",
        "--headless=new", "--no-first-run", "--no-proxy-server",
        "--window-size=200,200", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)
    ws = None
    for _ in range(20):
        try:
            lst = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DBG}/json/list"))
            t = [x for x in lst if x.get("type") == "page"]
            if t:
                ws = t[0]; break
        except Exception:
            pass
        time.sleep(0.4)
    assert ws, "no chrome target"
    from websockets.sync.client import connect
    c = connect(ws["webSocketDebuggerUrl"])
    mid = [0]

    def send(method, params=None):
        mid[0] += 1
        i = mid[0]
        c.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        while True:
            m = json.loads(c.recv())
            if m.get("id") == i:
                return m

    send("Page.enable")

    out = {}
    for em in EMOJIS:
        esc = "".join(f"\\u{ord(ch):04X}" for ch in em)
        expr = (
            "(() => { const c = document.createElement('canvas'); c.width=64; c.height=64;"
            " const ctx = c.getContext('2d');"
            " ctx.font = '48px Segoe UI Emoji';"
            " ctx.textBaseline='middle'; ctx.textAlign='center';"
            f" ctx.fillText('{esc}', 32, 34);"
            " const d = ctx.getImageData(0,0,64,64).data;"
            " let bin=''; for (let i=0;i<d.length;i++) bin += String.fromCharCode(d[i]);"
            " return btoa(bin); })()"
        )
        r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        val = r.get("result", {}).get("result", {}).get("value")
        if not val:
            print(f"SKIP U+{ord(em[0]):05X} (render failed)")
            continue
        raw = base64.b64decode(val)
        norm = normalize(raw, 64, 64)
        if not norm:
            print(f"SKIP U+{ord(em[0]):05X} (empty)")
            continue
        scored = sorted((distance(norm, ip), name) for name, ip in icons.items())
        best_name = scored[0][1]
        np_ = png_pixels(os.path.join(NUM, best_name))
        h = hash(np_[2]) if np_ else None
        named = named_by_hash.get(h)
        out[em] = {
            "file": named or best_name,
            "numbered": best_name,
            "named": bool(named),
            "dist": round(scored[0][0], 1),
            "top6": [n for _, n in scored[:6]],
            "top6_dist": [round(d, 1) for d, _ in scored[:6]],
        }
        print(f"U+{ord(em[0]):05X} -> {out[em]['file']:<32} top6: {', '.join(n.replace('Emojis_16x16_','').replace('.png','') for n in out[em]['top6'])}")

    json.dump(out, open("tools/icon-map.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("saved tools/icon-map.json")
    proc.kill()


if __name__ == "__main__":
    main()
