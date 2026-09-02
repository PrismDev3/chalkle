#!/usr/bin/env python3
"""Generate inline SVG data-URI brand thumbnails for Chalkle Apps/Proxies.

The proxy/app lists reference favicon JPEGs that render as near-black squares
on the dark UI (Discord, TikTok, Reddit, Twitch, X...). This script writes
clean single-color brand-glyph SVGs as data URIs and prints a JS snippet to
paste into apps.js.
"""
import urllib.parse

# brand: (glyph path in a 64x64 viewBox, fill color)
BRANDS = {
    "discord": (
        "M20 20a26 26 0 0 1 24 0c3 4 5 9 5 15l-4 6c-8 3-18 3-26 0l-4-6c0-6 2-11 5-15z"
        "M26 30a3 3 0 1 0 0.01 0M38 30a3 3 0 1 0 0.01 0",
        "#5865F2",
    ),
    "tiktok": (
        "M38 12c1 6 5 10 11 11v7c-4 0-8-1-11-3v13c0 8-6 14-14 14s-14-6-14-14 6-14 14-14"
        "c1 0 2 0 3 .3V33c-1-.6-2-1-3-1a7 7 0 1 0 7 7V12h7z",
        "#ff0050",
    ),
    "reddit": (
        "M32 10a5 5 0 0 1 5 5c0 .5-.1 1-.2 1.4L44 20a4 4 0 1 1-1 8l-1-1a22 22 0 0 1-20 0"
        "l-1 1a4 4 0 1 1-1-8l7-3.6A5 5 0 0 1 32 10z"
        "M24 32a3 3 0 1 0 .01 0M40 32a3 3 0 1 0 .01 0M32 42c3 0 5-1 7-3l-2-2c-3 2-7 2-10 0l-2 2c2 2 4 3 7 3z",
        "#FF4500",
    ),
    "twitch": (
        "M14 10h36v24l-10 10H30l-6 6h-6v-6h-6V16l6-6z M30 20v12M40 20v12",
        "#9146FF",
    ),
    "x": (
        "M14 12h8l10 13 10-13h6L36 32l14 20h-8L31 38 20 52h-6l14-20L14 12z",
        "#ffffff",
    ),
}


def svg_uri(glyph, color):
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="14" fill="{color}"/>'
        f'<path d="{glyph}" fill="none" stroke="#fff" stroke-width="4" '
        'stroke-linecap="round" stroke-linejoin="round"/></svg>'
    )
    return "data:image/svg+xml," + urllib.parse.quote(svg, safe="")


if __name__ == "__main__":
    for name, (glyph, color) in BRANDS.items():
        print(f"{name}:")
        print(f'  "{svg_uri(glyph, color)}"')
