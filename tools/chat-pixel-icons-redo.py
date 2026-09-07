"""Redo the pixel-icon swap safely.

Recovery: chat.html lost ~21KB of code (QUICK_REACTIONS const + renderReactions
definition) due to a bad pre/post slice in the previous fix pass. deploy-static/
chat.html is the pre-icons copy with every earlier fix, so start from it.

Method: protect the EMOJI_CATS block and QUICK_REACTIONS line with \x00
placeholders, swap chrome emojis in the remainder, then restore. No offset
math anywhere.
"""
import base64
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
SRC = "deploy-static/chat.html"
DST = "chat.html"
NAMED = r"C:/Users/zeqrY/Downloads/emojis(1)"
NUM = r"C:/Users/zeqrY/Downloads/Emojis_Free/Emojis_16x16_Free"

SWAP = {
    # panel headers / tray
    "\U0001f4e1": 245,                  # satellite dish
    "\U0001f553": "clock_gray.png",     # clock face (menu / headers)
    "\U0001f550": "clock_gray.png",     # one o'clock (recent rooms row)
    "\u26a0\ufe0f": "warning_triangle_yellow.png",
    "\u26a0": "warning_triangle_yellow.png",
    "\U0001f4cc": "pin_red.png",
    "\U0001f58d": "crayon_pink.png",
    "\u270f": "crayon_pink.png",
    "\U0001f464": 17,                   # person silhouette
    "\U0001f465": 16,                   # people silhouettes
    "\U0001f5d1": "trash_can_gray.png",
    "\u2709": "envelope_gray.png",
    "\U0001f514": "bell_gold.png",
    "\U0001f515": "bell_gold.png",
    "\U0001f50d": "magnifier_gray.png",
    "\U0001f517": "chain_link.png",
    "\U0001f507": 24,                   # speaker waves (labels carry ON/OFF)
    "\u2699": "gear_gray.png",
    "\U0001f4a1": "lightbulb_yellow.png",
    "\U0001f4ce": 100,                  # paperclip
    "\U0001f4ac": "speech_bubble_gray.png",
    "\U0001f4e2": 19,                   # loudspeaker
    "\U0001f4e3": 19,                   # megaphone
    "\U0001f3e0": "house_tan.png",
    "\U0001f6e1": "shield_gray.png",
    "\U0001f4be": "floppy_disk_gray.png",
    "\U0001f3a8": "palette_paint.png",
    "\U0001f389": 185,                  # party popper
    "\u2600": 6,                        # sun
    "\U0001f319": 290,                  # moon
    # social / chrome
    "\U0001f60a": 85,                   # smiling face
    "\U0001f44d": 34,                   # thumbs up (chrome uses only)
    "\U0001f44e": 47,                   # thumbs down (chrome uses only)
    "\U0001f91d": 1,                    # handshake
    "\u2615": 305,                      # hot beverage -> coffee cup
    "\U0001f575": 86,                   # sleuth -> hatted face
    "\u25b6": "play_button_gray.png",   # play
    "\U0001f512": "lock_gold.png",        # lock (privacy header)
    "\U0001f6ab": "no_entry_red.png",     # no entry (notification toggles)
}

def uri(p):
    return "data:image/png;base64," + base64.b64encode(io.open(p, "rb").read()).decode()

uris = {}
for e, ref in SWAP.items():
    p = (NUM + "/Emojis_16x16_%d.png" % ref) if isinstance(ref, int) else (NAMED + "/" + ref)
    uris[e] = uri(p)

s = io.open(SRC, encoding="utf-8").read()
assert "const QUICK_REACTIONS" in s and "function renderReactions" in s, "SRC is not the intact pre-icons file"

# 1) protect user-content zones with placeholders
mblk = re.search(r"const EMOJI_CATS = \{.*?\n    \};", s, re.S)
mqr = re.search(r"const QUICK_REACTIONS = \[.*?\];", s, re.S)
assert mblk and mqr, "protect anchors not found"
block, qr = mblk.group(0), mqr.group(0)
s = s.replace(block, "\x00EMOJI_BLOCK\x00", 1).replace(qr, "\x00QR\x00", 1)

# 2) swap chrome emojis (longest keys first for FE0F handling)
keys = sorted(uris, key=len, reverse=True)
n = 0
for e in keys:
    c = s.count(e)
    if c:
        s = s.replace(e, '<img class="pixi" src="%s" alt="">' % uris[e])
        n += c
print("chrome emoji instances swapped:", n)

# 3) restore protected zones + inject .pixi CSS
s = s.replace("\x00EMOJI_BLOCK\x00", block, 1).replace("\x00QR\x00", qr, 1)
css = """    /* pixel-art icon class (16x16 art, em-scaled so it fits any font size) */
    img.pixi {
      width: 1.18em;
      height: 1.18em;
      vertical-align: -0.22em;
      image-rendering: pixelated;
      margin: 0 1px
    }
"""
anchor = "    ::-webkit-scrollbar-thumb {"
assert anchor in s
s = s.replace(anchor, css + anchor, 1)

# 4) integrity asserts before writing
assert "const QUICK_REACTIONS" in s and "function renderReactions" in s
assert "pixi" not in block and "pixi" not in qr
assert s.count("\x00") == 0
io.open(DST, "w", encoding="utf-8", newline="").write(s)
print("written", DST, len(s), "bytes | pixi imgs:", s.count('img class="pixi"'))

# 5) JS-validity check of the two protected structures
js = ("const EMOJI_CATS = " + re.search(r"const EMOJI_CATS = (\{.*?\n    \});", s, re.S).group(1) + ";\n"
      + "const QUICK_REACTIONS = " + re.search(r"const QUICK_REACTIONS = (\[.*?\]);", s, re.S).group(1) + ";\n"
      + "console.log('cats', Object.keys(EMOJI_CATS).length, 'qr', QUICK_REACTIONS.length);")
io.open("tmp-emoji-check.mjs", "w", encoding="utf-8").write(js)

# 6) remaining emoji outside protected zones (informational)
blk_start = s.find(block)
pat = re.compile(u"[\u2300-\u27bf\u2b00-\u2bff\U0001F000-\U0001FAff]")
left = {}
for i, line in enumerate(s.split("\n"), 1):
    if "const EMOJI_CATS" in line or "const QUICK_REACTIONS" in line or "postSys(" in line:
        continue
    for mm in pat.finditer(line):
        left.setdefault(ascii(mm.group()), []).append(i)
print("remaining emoji chars outside protected zones:", sum(len(v) for v in left.values()))
for g, ls in sorted(left.items(), key=lambda kv: -len(kv[1]))[:12]:
    print(" ", g, "x%d" % len(ls), ls[:6])
