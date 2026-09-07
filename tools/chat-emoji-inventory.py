"""Inventory emoji usage in chat.html: count per char and flag which lines
are emoji-picker / room-emoji content (must stay real emojis) vs UI chrome."""
import io
import re
import unicodedata

s = io.open("chat.html", encoding="utf-8").read()
lines = s.split("\n")

# find the emoji picker data arrays and room-emoji arrays to protect
protected = []
for i, ln in enumerate(lines):
    low = ln.lower()
    if ("emojicats" in low or "emoji-categories" in low or "emoji_picker" in low
            or "roomemoji" in low or "emojis =" in low or "emoji:" in low):
        protected.append(i + 1)

def is_emoji(ch):
    if ch in "\u200d\ufe0f\ufe0e":
        return False
    cat = unicodedata.category(ch)
    return cat == "So" or (cat == "Sk" and ord(ch) > 0x2600) or 0x1F000 <= ord(ch) <= 0x1FAFF

counts = {}
ctx = {}
for i, ln in enumerate(lines):
    for ch in ln:
        if is_emoji(ch):
            counts[ch] = counts.get(ch, 0) + 1
            ctx.setdefault(ch, []).append(i + 1)

prot_lines = set()
for n in protected:
    for d in range(-2, 3):
        prot_lines.add(n + d)

print("=== picker/content-adjacent line numbers:", sorted(set(protected))[:20])
print("=== emoji -> count, sample lines (P = also near picker data) ===")
for ch, n in sorted(counts.items(), key=lambda kv: -kv[1]):
    sample = [x for x in ctx[ch][:4]]
    flags = "".join("P" if x in prot_lines else "." for x in ctx[ch][:12])
    try:
        name = unicodedata.name(ch)[:36]
    except ValueError:
        name = "?"
    print(f"U+{ord(ch):05X} x{n:<4} {flags:<12} {name:<38} lines {sample}")
