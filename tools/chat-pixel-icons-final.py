"""Final straggler swaps on the already-swapped chat.html."""
import base64
import io
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
CHAT = "chat.html"
NAMED = r"C:/Users/zeqrY/Downloads/emojis(1)"

def uri(p):
    return "data:image/png;base64," + base64.b64encode(io.open(p, "rb").read()).decode()

s = io.open(CHAT, encoding="utf-8").read()
imgs = {
    "\U0001f6aa": "back_button_gray.png",   # Leave Room
    "\U0001f511": "key_gold.png",           # Account
    "\U0001f4e6": "box_wood.png",           # New version available
    "\u2714": "check_circle_green.png",     # Send
    "\u25c0": "back_button_gray.png",       # Welcome prev
}
n = 0
for e, f in imgs.items():
    c = s.count(e)
    s = s.replace(e, '<img class="pixi" src="%s" alt="">' % uri(NAMED + "/" + f))
    n += c

# red/green presence dots: emoji ignores CSS color, a styled span inherits it
DOT_CSS = """    img.pixi, span.pixi-dot {
      image-rendering: pixelated
    }

    span.pixi-dot {
      display: inline-block;
      width: .72em;
      height: .72em;
      border-radius: 50%;
      background: currentColor;
      vertical-align: -0.02em;
      margin: 0 1px
    }
"""
dot_css_anchor = "    img.pixi {"
assert dot_css_anchor in s
s = s.replace(dot_css_anchor, DOT_CSS + "    img.pixi {", 1)
n += s.count("\U0001f534") + s.count("\U0001f7e2")
s = s.replace("\U0001f534", '<span class="pixi-dot"></span>')
s = s.replace("\U0001f7e2", '<span class="pixi-dot"></span>')

io.open(CHAT, "w", encoding="utf-8", newline="").write(s)
print("straggler instances swapped:", n, "| pixi imgs:", s.count('img class="pixi"'),
      "| dots:", s.count('pixi-dot'))
