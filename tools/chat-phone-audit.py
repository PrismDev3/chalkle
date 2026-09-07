"""Phone UX audit for chat.html: broken <img> text, stray middots, button
clutter. Prints context for every match so the fixes are grounded."""
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
s = io.open("chat.html", encoding="utf-8").read()
lines = s.split("\n")


def dump(title, regex, max_hits=18):
    print("=" * 8, title)
    hits = 0
    for i, ln in enumerate(lines, 1):
        if re.search(regex, ln):
            print(f"{i}: {ln.strip()[:150]}")
            hits += 1
            if hits >= max_hits:
                print("... more")
                break
    if not hits:
        print("(none)")


dump("phone meta tags", r'name="viewport"|apple-mobile-web-app|mobile-web-app|manifest', 10)
dump("literal '<img>' text in strings", r"'>\s*<img|'<img|\"<img", 10)
dump("textContent/innerHTML assignments containing img", r"\.textContent\s*=.*<img|\.innerHTML\s*=.*<img", 12)
dump("middot in markup/strings", r"&#183;|\u00b7|&middot;", 20)
dump("titlebar buttons", r'class="tbbtn"', 12)
dump("statusbar cells", r'class="sc"', 12)
