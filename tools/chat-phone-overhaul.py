"""Phone UX overhaul for chat.html.

A. Bug fixes:
   - #mbtn-phone rendered literal backslash-u00b7 text -> real glyph dots
   - four .textContent assignments had been swapped to <img> markup (rendered
     literally as "<img ...>" on screen) -> plain text
   - #nremoji placeholder attribute was corrupted with an <img> tag
B. Phone dock: fixed bottom nav (Rooms / Friends / Settings), lobby+settings
   only; in dock mode the lobby shows ONE pane at a time. Buttons drive the
   real switchFSubTab / switchRoomLTab / openSettings functions.
C. Phone declutter CSS: hide host-code meta lines, badges, mute menubar labels.
D. Bookmark polish: Apple/PWA meta, iOS title, notification-icon link.
Every replacement asserts its anchor; any miss aborts before writing.
"""
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "chat.html"
s = io.open(P, encoding="utf-8").read()
orig_len = len(s)
changed = []


def rep(old, new, tag, must=1):
    global s
    c = s.count(old)
    if must and c < 1:
        raise SystemExit(f"ANCHOR MISS [{tag}]: {old[:90]!r}")
    if c:
        s = s.replace(old, new, 1)
        changed.append(tag)


# ---------- A1: literal backslash-u00b7 dots on the phone members button ----------
rep('title="Members">\\u00b7\\u00b7\\u00b7</div>', 'title="Members">\u00b7\u00b7\u00b7</div>', "A1 mbtn dots")

# ---------- A2: four textContent assignments corrupted with <img> ----------
m = re.search(r"el\.textContent = '<img class=\"pixi\" src=\"data:image/png;base64,[^\"]*\" alt=\"\"> Letters, numbers, _ only';", s)
if not m:
    raise SystemExit("ANCHOR MISS [A2a]")
s = s.replace(m.group(0), "el.textContent = 'Letters, numbers, _ only';", 1)
changed.append("A2a username err")

m = re.search(r"el\.textContent = \(on \? '<img class=\"pixi\" src=\"data:image/png;base64,[^\"]*\" alt=\"\">' : '<img class=\"pixi\" src=\"data:image/png;base64,[^\"]*\" alt=\"\">'\) \+ ' Join/Leave Messages: ' \+ \(on \? 'ON' : 'OFF'\);", s)
if not m:
    raise SystemExit("ANCHOR MISS [A2b]")
s = s.replace(m.group(0), "el.textContent = 'Join/Leave Messages: ' + (on ? 'ON' : 'OFF');", 1)
changed.append("A2b joinleave label")

m = re.search(r"linkEl\.textContent = '<img class=\"pixi\" src=\"data:image/png;base64,[^\"]*\" alt=\"\"> ' \+ om\.link\.slice\(0, 60\);", s)
if not m:
    raise SystemExit("ANCHOR MISS [A2c]")
s = s.replace(m.group(0), "linkEl.textContent = om.link.slice(0, 60);", 1)
changed.append("A2c owner link")

m = re.search(r"nextBtn\.textContent = _welcomeStep === WELCOME_STEPS - 1 \? 'Get Started! <img class=\"pixi\" src=\"data:image/png;base64,[^\"]*\" alt=\"\">' : 'Next <img class=\"pixi\" src=\"data:image/png;base64,[^\"]*\" alt=\"\">';", s)
if not m:
    raise SystemExit("ANCHOR MISS [A2d]")
s = s.replace(m.group(0), "nextBtn.textContent = _welcomeStep === WELCOME_STEPS - 1 ? 'Get Started!' : 'Next';", 1)
changed.append("A2d welcome btn")

# ---------- A3: nremoji placeholder attribute corrupted ----------
m = re.search(r'<input type="text" id="nremoji" maxlength="2" placeholder="<img class="pixi" src="[^"]*" alt="">"', s)
if not m:
    raise SystemExit("ANCHOR MISS [A3]")
s = s.replace(m.group(0), '<input type="text" id="nremoji" maxlength="2" placeholder="\u2615">', 1)
changed.append("A3 nremoji placeholder")

# ---------- B1: dock markup, right before the lobby window ----------
dock = (
    '<nav id="phone-dock" aria-label="Phone navigation" hidden>'
    '<button type="button" id="dock-rooms" onclick="phoneDockGo(\'rooms\')">'
    '<img class="pixi" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaklEQVR4nKWTwQ3AIAxE45kBdIBawC5gCVwCq8FVoA6gE7gK1IF2QCv7J5fUxCQfPXn0YAvY2Ke8xHnIPcPe5QZO2CEctSCQCejaWHhGBQQNnFRw0sFNBiczvDTx0cTNFjc73Lzx0sRNE6/mACY1Yis7xO3qUgAAAABJRU5ErkJggg==" alt="">'
    "<span>Rooms</span></button>"
    '<button type="button" id="dock-friends" onclick="phoneDockGo(\'friends\')">'
    '<img class="pixi" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfElEQVR4nKWTsQ3DIAxEnYkOkIkG0A2aiQbQDZqJBtANmokG0A2aiQbQDZqJBtANTeWSpCbJzlEfqQU7jD7klFPIoQKUIqjADtBDGUF6aCO0CZ4IDaQGXuVkoM0eHzu4BcxRTa1NwCwXnQ2dZmnp5dyxhMcxJ/JF70csk98DYx2PfQGo0x1JMgAAAABJRU5ErkJggg==" alt="">'
    "<span>Friends</span></button>"
    '<button type="button" id="dock-settings" onclick="phoneDockGo(\'settings\')">'
    '<img class="pixi" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfUlEQVR4nKWTwQ3DIAxE45kBdIBawDKADlAG0AHKADpAGUAHKAPlgFbSLymhaXJLTnJT9MlXbqUEfgHeAhSgBkWCMoQWzAFa2CDoICWwRWigT9BBiqCZ/MDNQEf9qIWe1n3VdZz0mWjkw1AhCY0yPUkpa0hKm6X/7QKDeoWNPQAAAABJRU5ErkJggg==" alt="">'
    "<span>Settings</span></button>"
    "</nav>"
)
rep('<div id="lw" class="win mscr">', dock + '<div id="lw" class="win mscr">', "B1 dock markup")

# ---------- B2: dock CSS inside the phone media query ----------
dock_css = """
      /* ---- bottom dock: Rooms / Friends / Settings ---- */
      #phone-dock {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 945;
        display: none; border-top: 2px solid var(--blo); background: var(--bg2);
      }
      #phone-dock button {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
        background: transparent; border: none; border-top: 2px solid transparent;
        color: var(--txt3); font-family: 'Share Tech Mono', monospace;
        font-size: 10px; letter-spacing: 1px; cursor: pointer;
        padding: 8px 0 calc(8px + env(safe-area-inset-bottom, 0px));
      }
      #phone-dock button img.pixi { width: 20px; height: 20px }
      #phone-dock button.on { color: var(--acc2); border-top-color: var(--acc2) }
      body.dock-on #phone-dock { display: flex }
      body.dock-on .mscr.on { height: calc(100dvh - 64px) !important }
      /* dock mode: one lobby pane at a time */
      body[data-dock] .lcols { overflow: hidden }
      body[data-dock="rooms"] .lcols > .lpan:last-child { display: none }
      body[data-dock="rooms"] .lcols > .lpan:first-child { flex: 1 !important }
      body[data-dock="friends"] .lcols > .lpan:first-child { display: none }
      body[data-dock="friends"] .lcols > .lpan:last-child { flex: 1 !important }
      body[data-dock] .lpan .rlist { max-height: none }

      /* declutter: mute menubar labels; hide host/code meta lines + badges */
      .menubar .mi { display: none }
      .menubar .mdrop { display: inline-block }
      .menubar .mdrop > .msubmenu { display: inline-flex }
      body[data-dock] .rrm { display: none }
      body[data-dock] .ccbadge { display: none }
      .ustrip { gap: 5px; padding: 5px 6px }
      .lact { gap: 4px }
      .lact .btn { padding: 8px 10px; font-size: 12px }
      .rtab, .rltab { padding: 7px 4px; font-size: 11px }
"""
anchor = "      .mbdrop-scrim { position: fixed; inset: 0; z-index: 940; background: rgba(0,0,0,.35) }"
rep(anchor, anchor + dock_css, "B2 dock css")

# ---------- B3: dock JS, inserted before the final closing script tag ----------
dock_js = """
    /* ---- phone dock (Rooms / Friends / Settings) ---- */
    let dockMode = null;
    function phoneDockGo(mode) {
      dockMode = (dockMode === mode && mode !== 'settings') ? null : mode;
      if (dockMode === 'settings') { openSettings(); } else { closeSettings(); }
      if (dockMode === 'friends') {
        switchFSubTab('friends');
      } else if (dockMode === 'rooms') {
        switchRoomLTab('public');
      }
      phoneDockSync();
    }
    function phoneDockSync() {
      const dock = document.getElementById('phone-dock');
      if (!dock) return;
      const lw = document.getElementById('lw');
      const sw = document.getElementById('sw');
      const inLobby = !!(lw && lw.classList.contains('on'));
      const inSettings = !!(sw && sw.classList.contains('on'));
      const inChat = !!((document.getElementById('cw') || {}).classList?.contains('on') || (document.getElementById('dw') || {}).classList?.contains('on'));
      /* first time the lobby appears, default the dock to Rooms */
      if (inLobby && dockMode === null) { dockMode = 'rooms'; }
      const on = !inChat && (inLobby || inSettings);
      dock.hidden = !on;
      document.body.classList.toggle('dock-on', on);
      if (on && inLobby && (dockMode === 'rooms' || dockMode === 'friends')) {
        document.body.dataset.dock = dockMode;
      } else {
        delete document.body.dataset.dock;
      }
      const map = { 'dock-rooms': 'rooms', 'dock-friends': 'friends', 'dock-settings': 'settings' };
      dock.querySelectorAll('button').forEach(b => b.classList.toggle('on', dockMode !== null && map[b.id] === dockMode));
    }
    setInterval(phoneDockSync, 400);
"""
idx = s.rfind("</script>")
if idx < 0:
    raise SystemExit("ANCHOR MISS [B3]: no closing script tag")
s = s[:idx] + dock_js + s[idx:]
changed.append("B3 dock js")

# ---------- D: bookmark / PWA polish ----------
rep(
    '<meta name="theme-color" content="#008080">',
    '<meta name="theme-color" content="#008080">\n'
    '  <meta name="apple-mobile-web-app-capable" content="yes">\n'
    '  <meta name="mobile-web-app-capable" content="yes">\n'
    '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n'
    '  <meta name="apple-mobile-web-app-title" content="Lunchbreak">\n'
    '  <link rel="apple-touch-icon" href="https://sunhaven.wiki.gg/images/Coffee.png">',
    "D1 apple meta",
)
rep("<title>Lunchbreak — Online Chat</title>", "<title>Lunchbreak</title>", "D2 ios title")

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("applied:", ", ".join(changed))
print(f"bytes {orig_len} -> {len(s)} ({len(s) - orig_len:+d})")
