"""Add pixel-art icons to iconless menu items in chat.html and declutter
the mobile lobby (hide ustrip Settings/Sign Out duplicated by the chips).
"""
import io
import json
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "chat.html"
s = io.open(P, encoding="utf-8").read()

icons = json.load(open("tmp-chat-icons.json", encoding="utf-8"))
DOOR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4nGP4jwoYSMUgYtSAATIARQM+PiFAfReQHA5UN2DoRCPD4DEAAD7yP+sSZNcpAAAAAElFTkSuQmCC"
REFRESH = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAASklEQVR4nGP4//8/AyUYlwQMoLOJMgBdMTIgaAAum3AaQoxmvJZQzQBiNWOoHzwGDHwgEmsI3nTAQERiwhDHZxM6wKqWlJCnjQEAAscgC0BVImcAAAAASUVORK5CYII="
CLOSE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAUElEQVR4nGP4//8/AyWYgRoGwACxmlDUYxUkVjO6FwgZglWeKEX4DCfGJrwuI+RcgmFDEwMo8gJFgUhRNP4n5Fd8CYlYzVgNIVYTydFItAEAYXMs/kslDU0AAAAASUVORK5CYII="


def img(uri):
    return f'<img class="pixi" src="{uri}" alt="">'


REPS = [
    # --- lobby menubar chips (the mobile top buttons) ---
    ('<span class="msub" onclick="doLogout()">Sign Out</span>',
     f'<span class="msub" onclick="doLogout()">{img(DOOR)} Sign Out</span>', 3),
    ('<span class="msub" onclick="loadLobby()">Refresh All</span>',
     f'<span class="msub" onclick="loadLobby()">{img(REFRESH)} Refresh All</span>', 1),
    ('<span class="msub" onclick="openSettings()">Settings...</span>',
     f'<span class="msub" onclick="openSettings()">{img(icons["gear"])} Settings...</span>', 3),
    # --- lobby ustrip quick buttons ---
    ('<button class="btn btnsm btnd" onclick="doLogout()">Sign Out</button>',
     f'<button class="btn btnsm btnd" onclick="doLogout()">{img(DOOR)} Sign Out</button>', 1),
    # --- room menubar ---
    ('<span id="ms-delroom" class="msub" onclick="deleteRoom()" style="display:none">Delete Room</span>',
     f'<span id="ms-delroom" class="msub" onclick="deleteRoom()" style="display:none">{img(icons["trash"])} Delete Room</span>', 1),
    ('<span class="msub" onclick="copyCode()">Copy Room Code</span>',
     f'<span class="msub" onclick="copyCode()">{img(icons["doc"])} Copy Room Code</span>', 1),
    ('<span class="msub" onclick="showPinnedModal()">View Pinned</span>',
     f'<span class="msub" onclick="showPinnedModal()">{img(icons["pin"])} View Pinned</span>', 1),
    # --- dm menubar ---
    ('<span class="msub" onclick="leaveDM()">Close DM</span>',
     f'<span class="msub" onclick="leaveDM()">{img(CLOSE)} Close DM</span>', 1),
    ('<span class="msub" onclick="showDMPinnedModal()">View Pinned Messages</span>',
     f'<span class="msub" onclick="showDMPinnedModal()">{img(icons["pin"])} View Pinned Messages</span>', 1),
    # --- settings modal sign out ---
    ('<button class="btn btnd" onclick="doLogout()">Sign Out</button>',
     f'<button class="btn btnd" onclick="doLogout()">{img(DOOR)} Sign Out</button>', 1),
]

applied = []
for old, new, expect in REPS:
    n = s.count(old)
    if n == 0:
        print(f"MISS: {old[:70]}")
        continue
    if n != expect:
        print(f"COUNT {n} != {expect}: {old[:70]}")
    s = s.replace(old, new, expect if n >= expect else n)
    applied.append(old[:60])

# --- mobile declutter: ustrip Settings/Sign Out are duplicated by chips + dock ---
CSS_OLD = "      .ustrip { gap: 5px; padding: 5px 6px }"
CSS_NEW = (
    "      .ustrip { gap: 5px; padding: 5px 6px }\n"
    "      /* declutter: chips + dock already offer these; strip the duplicates */\n"
    "      .ustrip .btn[onclick=\"openSettings()\"], .ustrip .btn[onclick=\"doLogout()\"] { display: none }\n"
    "      #lw .menubar .msub { font-size: 13px }\n"
)
if CSS_OLD in s:
    s = s.replace(CSS_OLD, CSS_NEW, 1)
    applied.append("mobile declutter CSS")
else:
    print("MISS: ustrip mobile CSS anchor")

io.open(P, "w", encoding="utf-8", newline="").write(s)
print(f"\nApplied {len(applied)}/{len(REPS) + 1} edits:")
for a in applied:
    print("  -", a)