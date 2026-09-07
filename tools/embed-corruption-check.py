"""Decode the /chat.html embeds from both single-file builds and check for
leftover corruption (literal backslash-u00b7, img-in-placeholder, img-in-textContent)."""
import base64
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
for build in ("build/chalkle-single.html", "build/chalkle-single-cdn.html"):
    s = io.open(build, encoding="utf-8", errors="replace").read()
    m = re.search(r'"/chat.html":\s*"data:text/html;base64,([A-Za-z0-9+/=]+)"', s)
    if not m:
        print(build, ": NO EMBED")
        continue
    d = base64.b64decode(m.group(1)).decode("utf-8", "replace")
    lit = len(re.findall(r"\\u00b7", d))
    ph = len(re.findall(r'placeholder="<img', d))
    tc = len(re.findall(r"\.textContent\s*=[^;]*?<img", d))
    dock = d.count("phoneDockGo")
    dots = '>\u00b7\u00b7\u00b7</div>' in d
    print(f"{build}: dock={dock} literal-u00b7={lit} bad-placeholder={ph} img-in-textContent={tc} mbtn-dots-fixed={dots}")
