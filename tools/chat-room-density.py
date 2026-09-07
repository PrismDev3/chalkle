"""Room-list density scaling for chat.html.

Few rooms -> rows grow into big readable tiles that fill the panel; more
rooms -> rows shrink; below the readability floor (density-xs) the list just
scrolls. Works for all four room lists (public/own/joined/recent) on desktop
and phone. All anchors asserted; aborts before writing on any miss.
"""
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "chat.html"
s = io.open(P, encoding="utf-8").read()
orig_len = len(s)
changed = []


def rep(old, new, tag):
    global s
    if s.count(old) < 1:
        raise SystemExit(f"ANCHOR MISS [{tag}]: {old[:90]!r}")
    s = s.replace(old, new, 1)
    changed.append(tag)


# ---------- 1: density CSS after the .rrn rule ----------
density_css = """
    /* ---- density-scaled room rows ----
       The list JS measures available height vs row count and sets a density
       class: few rooms render as big tiles that fill the panel, more rooms
       shrink stepwise, and density-xs is the readability floor - past it the
       list scrolls instead of shrinking further. */
    .rlist.density-xl .rrow { padding: 15px 12px; margin-bottom: 5px }
    .rlist.density-xl .rrn { font-size: 27px }
    .rlist.density-xl .rrm { font-size: 13px }
    .rlist.density-xl .rri { font-size: 30px }
    .rlist.density-xl .rrow .btn { font-size: 13px !important; padding: 7px 14px !important }
    .rlist.density-xl .rrow .badge { font-size: 11px }
    .rlist.density-xl .rrow .rrow-notif { font-size: 15px }
    .rlist.density-xl .rrow span[style*="font-size:9px"] { font-size: 13px !important; padding: 3px 6px !important }

    .rlist.density-lg .rrow { padding: 10px 9px; margin-bottom: 4px }
    .rlist.density-lg .rrn { font-size: 21px }
    .rlist.density-lg .rrm { font-size: 11px }
    .rlist.density-lg .rri { font-size: 21px }
    .rlist.density-lg .rrow .btn { font-size: 12px !important; padding: 5px 11px !important }
    .rlist.density-lg .rrow .badge { font-size: 10px }
    .rlist.density-lg .rrow span[style*="font-size:9px"] { font-size: 11px !important }

    .rlist.density-md .rrow { padding: 7px 7px; margin-bottom: 3px }
    .rlist.density-md .rrn { font-size: 17px }
    .rlist.density-md .rrm { font-size: 10px }
    .rlist.density-md .rri { font-size: 16px }

    .rlist.density-sm .rrow { padding: 4px 6px; margin-bottom: 2px }
    .rlist.density-sm .rrn { font-size: 15px }
    .rlist.density-sm .rri { font-size: 14px }

    /* readability floor: smaller than this never happens - the list scrolls */
    .rlist.density-xs .rrow { padding: 3px 5px; margin-bottom: 1px }
    .rlist.density-xs .rrn { font-size: 14px }
    .rlist.density-xs .rrm { display: none }
    .rlist.density-xs .rri { font-size: 13px }
    .rlist.density-xs .rrow .btn { font-size: 9px !important; padding: 1px 5px !important }
    .rlist.density-xs .rrow .badge { display: none }
"""
m = re.search(r"\.rrn \{[^}]*\}", s)
if not m:
    raise SystemExit("ANCHOR MISS [.rrn css block]")
s = s[: m.end()] + "\n" + density_css + s[m.end():]
changed.append("density css")

# ---------- 2: density JS before the dock block ----------
density_js = """
    /* ---- room-list density scaling (few rooms = big tiles, many = compact) ---- */
    function roomDensityClass(h, n) {
      const per = h / n;
      if (per >= 84) return 'density-xl';
      if (per >= 62) return 'density-lg';
      if (per >= 42) return 'density-md';
      if (per >= 30) return 'density-sm';
      return 'density-xs'; /* readability floor: list scrolls from here */
    }
    function applyRoomDensity(con) {
      if (!con) return;
      const rows = con.querySelectorAll('.rrow').length;
      const h = con.clientHeight - 8;
      con.classList.remove('density-xl', 'density-lg', 'density-md', 'density-sm', 'density-xs');
      if (!rows || h < 40) return; /* hidden or empty -> default sizes */
      con.classList.add(roomDensityClass(h, rows));
    }
    let _densityQueued = false;
    function queueDensity() {
      if (_densityQueued) return;
      _densityQueued = true;
      requestAnimationFrame(() => {
        _densityQueued = false;
        document.querySelectorAll('.rlist').forEach(applyRoomDensity);
      });
    }
    window.addEventListener('resize', queueDensity);
    setInterval(() => { if ((document.getElementById('lw') || {}).classList?.contains('on')) queueDensity(); }, 700);
"""
dock_anchor = "    /* ---- phone dock (Rooms / Friends / Settings) ---- */"
rep(dock_anchor, density_js + dock_anchor, "density js")

# ---------- 3: hook rrow (covers every render path incl. loadRec) ----------
rep(
    "row.onclick = () => joinRoom(id, data.code); con.appendChild(row);\n    }",
    "row.onclick = () => joinRoom(id, data.code); con.appendChild(row); queueDensity();\n    }",
    "rrow hook",
)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("applied:", ", ".join(changed))
print(f"bytes {orig_len} -> {len(s)} ({len(s) - orig_len:+d})")
