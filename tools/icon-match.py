"""Match named pixel icons to the unnamed Emojis_16x16_Free set by pixel hash.
Prints: which named files exist in the numbered set, and lists extras."""
import os
import struct
import zlib
from collections import defaultdict

NAMED = r"C:/Users/zeqrY/Downloads/emojis(1)"
NUM = r"C:/Users/zeqrY/Downloads/Emojis_Free/Emojis_16x16_Free"


def png_pixels(path):
    """Decode a small PNG to a hashable pixel tuple without PIL."""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None, None
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
        return (w, h), None
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 6: 4}[ctype]
    stride = w * ch
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
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
                out[o:o + 3] = line[x * 3:x * 3 + 3]
                out[o + 3] = 255
            elif ctype == 6:
                out[o:o + 4] = line[x * 4:x * 4 + 4]
            elif ctype == 0:
                g = line[x]
                out[o:o + 3] = bytes([g, g, g])
                out[o + 3] = 255
            elif ctype == 3:
                idx = line[x]
                out[o:o + 3] = plte[idx * 3:idx * 3 + 3]
                out[o + 3] = trns[idx] if (trns and idx < len(trns)) else 255
    return (w, h), bytes(out)


def sig(pix):
    """Coarse signature: 2x2 average color grid, alpha-weighted."""
    if not pix:
        return None
    w = int(len(pix) ** 0.25 * 4) or 1
    acc = [[0, 0, 0, 0] for _ in range(4)]
    n = len(pix) // 4
    side = max(1, int(n ** 0.5))
    for i in range(n):
        r, g, b, a = pix[i * 4:i * 4 + 4]
        if a < 40:
            continue
        px, py = i % side, i // side
        q = (min(3, py * 4 // side)) * 4 // 4
        cell = (min(3, py * 2 // max(1, side // 2))) * 2 + min(1, px * 2 // max(1, side // 2))
        cell = min(3, cell)
        c = acc[cell]
        c[0] += r * a; c[1] += g * a; c[2] += b * a; c[3] += a
    return tuple((c[0] // c[3], c[1] // c[3], c[2] // c[3]) if c[3] else (0, 0, 0) for c in acc)


def full_hash(pix):
    return hash(pix) if pix is not None else None


num_by_hash = {}
num_sizes = {}
for f in sorted(os.listdir(NUM)):
    if not f.endswith(".png"):
        continue
    size, pix = png_pixels(os.path.join(NUM, f))
    num_sizes[f] = size
    if pix is not None:
        num_by_hash[hash(pix)] = f

print("named -> numbered match")
matched = 0
extras_used = set()
for f in sorted(os.listdir(NAMED)):
    if not f.endswith(".png"):
        continue
    size, pix = png_pixels(os.path.join(NAMED, f))
    h = hash(pix) if pix is not None else None
    m = num_by_hash.get(h)
    if m:
        matched += 1
        extras_used.add(m)
        print(f"  {f:<36} == {m}")
    else:
        print(f"  {f:<36} -- no exact match ({size})")
print(f"matched {matched}")
