"""Dump full context (data URIs truncated) for the broken sites in chat.html."""
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
s = io.open("chat.html", encoding="utf-8").read()
lines = s.split("\n")


def shorten(ln):
    return re.sub(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]+", "data:...TRUNC", ln)


print("=== literal backslash-u00b7 sites (true backslash char):")
pat = re.compile(r"\\u00b7")
for i, ln in enumerate(lines, 1):
    if pat.search(ln):
        print(f"--- line {i}")
        print(shorten(ln)[:500])

print()
print("=== img-in-textContent sites (full assignment, truncated URIs):")
pat2 = re.compile(r"\.textContent\s*=[^;]*?<img")
for i, ln in enumerate(lines, 1):
    if pat2.search(ln):
        print(f"--- line {i}")
        print(shorten(ln)[:700])
