"""Generate hand-drawn 16x16 pixel-art PNGs (base64, white on transparent)
for the chat UI chrome: sign out (door + right arrow) and refresh
(circular clockwise arrows). Prints data URIs + ASCII previews.
"""
import base64
import struct
import sys
import zlib

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 16x16 maps, '#' = on, '.' = transparent
ICONS = {
    "signout": [
        "XXX.............",
        "XXX.............",
        "XXX.............",
        "XXX.............",
        "XXX.............",
        "XXX.............",
        "XXX..........XXX",
        "XXX.XXXXXXXXXXX.",
        "XXX..........XXX",
        "XXXX............",
        "XXXX............",
        "XXX.............",
        "XXX.............",
        "XXX.............",
        "XXX.............",
        "XXX.............",
    ],
    "refresh": [
        "................",
        ".....XX.XX......",
        "....X...XXX.....",
        "...X.....XXX....",
        "..X.........X...",
        "..X.........X...",
        ".X...........X..",
        ".X...........X..",
        ".X...........X..",
        "..X.........X...",
        "..X.........X...",
        "...X.......X....",
        "....X.....X.....",
        ".....XXXXX......",
        "................",
        "................",
    ],
    "close": [
        "................",
        "................",
        "XX..........XX..",
        ".XX........XX...",
        "..XX......XX....",
        "...XX....XX.....",
        "....XX..XX......",
        ".....XXXX.......",
        ".....XXXX.......",
        "....XX..XX......",
        "...XX....XX.....",
        "..XX......XX....",
        ".XX........XX...",
        "XX..........XX..",
        "................",
        "................",
    ],
}


def make_png(rows):
    w = h = 16
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for px in row:
            raw += bytes([255, 255, 255, 255 if px != "." else 0])

    def chunk(typ, data):
        out = struct.pack(">I", len(data)) + typ + data
        out += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


for name, rows in ICONS.items():
    assert all(len(r) == 16 for r in rows), name
    on = sum(r.count("X") for r in rows)
    print(f"== {name} ({on}/256 px) ==")
    for r in rows:
        print(r.replace("X", "##")[:32])
    print(f"{name}: data:image/png;base64,{make_png(rows)}")
    print()