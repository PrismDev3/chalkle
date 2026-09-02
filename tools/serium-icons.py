"""Generate distinct flat-fill SVG icons for Serium 1-20."""
import colorsys
import sys
from pathlib import Path

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("assets/proxies")
N = 20
BOLT = "M34 14L22 34h9l-4 16 14-22h-9l6-14z"

def hue_to_hex(h):
    r, g, b = colorsys.hls_to_rgb(h / 360.0, 0.55, 0.62)
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))

def serium_svg(n):
    color = hue_to_hex((n - 1) * (300.0 / N))
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="14" fill="{color}"/>'
        f'<path d="{BOLT}" fill="#0c1210" opacity="0.85"/>'
        f'<text x="32" y="58" text-anchor="middle" font-family="system-ui,sans-serif" '
        f'font-size="11" font-weight="700" fill="#fff">{n}</text></svg>'
    )

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for n in range(1, N + 1):
        (OUT / f"serium-{n:02d}.svg").write_text(serium_svg(n), encoding="utf-8")

if __name__ == "__main__":
    main()
