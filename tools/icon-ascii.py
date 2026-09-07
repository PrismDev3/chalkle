"""Print 16x16 PNGs as ASCII art (by luminance/alpha) so pixel icons can be
identified by eye. Usage: python tools/icon-ascii.py 305 306 249 ..."""
import os
import struct
import sys
import zlib

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
NUM = r"C:/Users/zeqrY/Downloads/Emojis_Free/Emojis_16x16_Free"


def png_rgba(path):
    data = open(path, "rb").read()
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
                g = line[x]; out[o:o + 3] = bytes([g] * 3); out[o + 3] = 255
            elif ctype == 3:
                ix = line[x]
                out[o:o + 3] = plte[ix * 3:ix * 3 + 3]
                out[o + 3] = trns[ix] if (trns and ix < len(trns)) else 255
    return w, h, bytes(out)


RAMP = " .:-=+*#%@"


def show(f):
    path = os.path.join(NUM, f)
    if not os.path.exists(path):
        print(f, "missing"); return
    w, h, pix = png_rgba(path)
    print(f"--- {f} ---")
    for y in range(h):
        row = ""
        for x in range(w):
            o = (y * w + x) * 4
            r, g, b, a = pix[o], pix[o + 1], pix[o + 2], pix[o + 3]
            if a < 30:
                row += ".."
                continue
            lum = (r * 299 + g * 587 + b * 114) // 1000
            ch = RAMP[min(9, (10 - lum * 10 // 256) if lum < 250 else 0)]
            row += ch + ch
        print(row)


for num in sys.argv[1:]:
    show(f"Emojis_16x16_{num}.png" if not num.endswith(".png") else num)
