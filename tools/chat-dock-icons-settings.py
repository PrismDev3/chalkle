"""Dock icons from the real pixel packs + phone settings full-screen layout.

1. Replace the three fabricated dock icon data URIs with real PNGs:
   Rooms -> house_tan.png, Friends -> Emojis_16x16_17.png (person),
   Settings -> gear_gray.png (all embedded as base64, self-contained).
2. Phone CSS: settings (#sw) becomes a full-screen page sitting above the
   dock; its 140px sidebar becomes a horizontal chip strip; bigger touch
   targets. Desktop keeps the floating window.
All anchors asserted; aborts before writing on any miss.
"""
import base64
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "chat.html"
s = io.open(P, encoding="utf-8").read()
orig_len = len(s)
changed = []


def b64(path):
    return base64.b64encode(io.open(path, "rb").read()).decode("ascii")


PACK = r"C:/Users/zeqrY/Downloads/emojis(1)"
NUM = r"C:/Users/zeqrY/Downloads/Emojis_Free/Emojis_16x16_Free"
icons = {
    "rooms": b64(PACK + "/house_tan.png"),
    "friends": b64(NUM + "/Emojis_16x16_17.png"),
    "settings": b64(PACK + "/gear_gray.png"),
}


def rep(old, new, tag):
    global s
    if s.count(old) < 1:
        raise SystemExit(f"ANCHOR MISS [{tag}]: {old[:90]!r}")
    s = s.replace(old, new, 1)
    changed.append(tag)


# ---------- 1: real dock icons ----------
for tab, key in (("rooms", "rooms"), ("friends", "friends"), ("settings", "settings")):
    m = re.search(
        r'(id="dock-%s"[^>]*>\s*<img class="pixi" src=")data:image/png;base64,[A-Za-z0-9+/=]+(" alt="">)' % tab,
        s,
    )
    if not m:
        raise SystemExit(f"ANCHOR MISS [icon {tab}]")
    s = s[: m.start()] + m.group(1) + "data:image/png;base64," + icons[key] + m.group(2) + s[m.end():]
    changed.append(f"icon {tab}")

# ---------- 2: phone settings full-screen CSS (inside the phone media query) ----------
css = """
      /* ---- settings: full-screen page above the dock, chips instead of sidebar ---- */
      #sw.dock-on, body.dock-on #sw {
        top: 0; left: 0; transform: none; width: 100vw; max-width: 100vw;
        height: calc(100dvh - 64px); max-height: calc(100dvh - 64px);
        border-left: none; border-right: none; box-shadow: none; z-index: 950;
      }
      body.dock-on #sw .snav {
        width: 100%; flex-direction: row; overflow-x: auto; border-right: none;
        border-bottom: 2px solid var(--blo); padding: 5px; gap: 5px; flex-shrink: 0;
        -webkit-overflow-scrolling: touch
      }
      body.dock-on #sw .snav .sni {
        flex: none; padding: 9px 12px; font-size: 13px; white-space: nowrap;
        border: 2px solid var(--blo); background: var(--bg3)
      }
      body.dock-on #sw .sbody { flex-direction: column }
      body.dock-on #sw .ssec { padding: 12px 12px 6px }
      body.dock-on #sw .gbox { padding: 12px 10px 8px }
      body.dock-on #sw input[type="range"] { min-height: 32px }
      body.dock-on #sw .toggle-wrap { margin: 8px 0 }
"""
anchor = "      /* declutter: mute menubar labels; hide host/code meta lines + badges */"
rep(anchor, css + "\n" + anchor, "phone settings css")

# ---------- 3: dock button chrome polish ----------
rep(
    "      #phone-dock button img.pixi { width: 20px; height: 20px }",
    "      #phone-dock button img.pixi { width: 22px; height: 22px; image-rendering: pixelated }\n"
    "      #phone-dock button { -webkit-tap-highlight-color: transparent }",
    "dock icon size",
)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("applied:", ", ".join(changed))
print(f"bytes {orig_len} -> {len(s)} ({len(s) - orig_len:+d})")
