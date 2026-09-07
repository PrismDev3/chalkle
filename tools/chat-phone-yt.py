"""Phone UI redesign + YouTube embeds for chat.html.

Phone (<=700px):
  - every chat window goes full-screen (100dvh), desktop chrome removed
  - menubar dropdowns flatten into a scrollable action chip strip (all
    functions stay reachable, no new markup paths)
  - members panel becomes a slide-over drawer toggled by a phone-only
    titlebar button (added once at runtime)
  - 16px input font (no iOS zoom), bigger touch targets, lobby stacks
  - status bar hidden, emoji picker becomes a bottom sheet

YouTube:
  - procTxt detects youtube.com/watch, youtu.be, /shorts/ links and renders
    a click-to-load 16:9 player (privacy-enhanced youtube-nocookie iframe on
    first tap). Plain links elsewhere keep working. One player auto-pauses
    any previously opened one.
"""
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
CHAT = "chat.html"

s = io.open(CHAT, encoding="utf-8").read()

# ============================================================
# 1) CSS: phone layout + youtube embed card
# ============================================================
css_anchor = "  </style>"
assert css_anchor in s

PHONE_CSS = """
    /* ===================== phone layout (<=700px) ===================== */
    @media (max-width: 700px) {
      html, body { height: 100% ; overflow: hidden }

      #area { padding: 0; align-items: stretch; justify-content: stretch }

      .win.mscr {
        width: 100vw !important;
        max-width: 100vw !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
        border-left: none; border-right: none;
        box-shadow: none
      }

      /* clean titlebar: tighter, sticky-safe */
      .titlebar { font-size: 17px; padding: 6px 8px }
      .tbbtn { width: 30px; height: 28px; font-size: 12px }

      /* flatten menubar dropdowns into a chip strip */
      .menubar { display: block; overflow-x: auto; border-bottom: 2px solid var(--blo); -webkit-overflow-scrolling: touch }
      .menubar .mdrop { display: inline-block }
      .menubar .mdrop > .mi { display: none }
      .menubar .msubmenu {
        display: inline-flex; position: static; border: none; box-shadow: none;
        min-width: 0; background: transparent; padding: 3px 4px; gap: 6px; overflow-x: auto
      }
      .menubar .msep { display: none }
      .menubar .msub {
        display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
        border: 2px solid var(--blo); background: var(--bg2);
        padding: 7px 12px; font-size: 13px; border-bottom-width: 2px; cursor: pointer
      }
      .menubar .msub:active { background: var(--acc); color: #fff }
      .menubar .msub[style*="display:none"] { display: none }
      .menubar .mdrop:hover > .msubmenu { display: inline-flex }

      /* buttons: reachable thumb targets */
      .btn { padding: 9px 14px; font-size: 14px }
      .btnsm { padding: 7px 10px; font-size: 12px }
      .fbtn { padding: 8px 12px; font-size: 12px }
      .msub { padding: 9px 12px }

      /* lobby: stack the two panels, room list gets the height */
      .lcols { flex-direction: column; overflow-y: auto }
      .lpan { flex: none; max-height: none }
      .lpan .rlist { max-height: 46vh }

      /* room / DM panes */
      .cbody { flex-direction: column }
      .mbrpan {
        position: fixed; top: 0; right: 0; bottom: 0; width: min(78vw, 300px); z-index: 950;
        transform: translateX(100%); transition: transform .18s ease-out;
        box-shadow: -3px 0 0 rgba(0,0,0,.35); border-left: 2px solid var(--blo);
        background: var(--bg); display: flex; flex-direction: column
      }
      .mbrpan.mopen { transform: translateX(0) }
      .mbrlst { flex: 1 }
      .cinp { font-size: 16px !important; height: 44px }
      .cibar { padding: 7px; gap: 6px }
      .emoji-btn { padding: 10px }
      .emoji-panel {
        position: fixed; left: 0; right: 0; bottom: 0; top: auto;
        width: 100%; max-height: 52vh; z-index: 960
      }
      .statusbar { display: none }
      .typing-bar { min-height: 18px }

      /* message rows: airier, long-press-friendly */
      .msg { padding: 8px 9px; gap: 8px }
      .mav { width: 34px; height: 34px }
      .mtxt { font-size: 14px }
      .msg-actions-btn { padding: 6px 10px; font-size: 14px }
      .msg-actions-dropdown { font-size: 14px }
      .msg-action-item { padding: 11px 14px; font-size: 14px }
      .msg-reply-ctx { font-size: 11px }

      /* the phone-only members button */
      #mbtn-phone {
        width: 30px; height: 28px; background: var(--face); color: var(--txt);
        border-top: 2px solid var(--bhi); border-left: 2px solid var(--bhi);
        border-right: 2px solid var(--bout); border-bottom: 2px solid var(--bout);
        font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer
      }
      .mbdrop-scrim { position: fixed; inset: 0; z-index: 940; background: rgba(0,0,0,.35) }
    }

    /* ===================== youtube embed card ===================== */
    .yt-embed {
      margin-top: 4px; max-width: 480px;
      border: 1px solid var(--blo); background: var(--bg3)
    }
    .yt-thumb {
      position: relative; display: block; width: 100%; aspect-ratio: 16 / 9;
      background: #000 center / cover no-repeat; cursor: pointer; border: 0; padding: 0
    }
    .yt-thumb::after {
      content: ''; position: absolute; inset: 0;
      background: center / 64px 46px no-repeat
    }
    .yt-thumb .yt-meta {
      position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between;
      padding: 3px 6px; font-size: 10px; color: #ddd; background: rgba(0,0,0,.55); letter-spacing: .5px
    }
    .yt-embed iframe { display: block; width: 100%; aspect-ratio: 16 / 9; border: 0 }
    .yt-embed .yt-title { display: block; padding: 4px 6px; font-size: 11px; color: var(--txt2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
"""

s = s.replace(css_anchor, PHONE_CSS + css_anchor, 1)

# ============================================================
# 2) JS: youtube helpers
# ============================================================
js_anchor = "    const IMGRE = "
assert js_anchor in s

YT_JS = """    /* ---- YouTube link detection + click-to-load embed ---- */
    function ytId(url) {
      try {
        const u = new URL(url);
        if (u.hostname.replace(/^(www|m|music)\\./, '') === 'youtu.be') return (u.pathname.slice(1) || '').split('/')[0];
        if (!/(^|\\.)youtube(-nocookie)?\\.com$/.test(u.hostname)) return '';
        if (u.searchParams.get('v')) return u.searchParams.get('v');
        const mm = u.pathname.match(/^\\/(?:shorts|embed|live|v)\\/([\\w-]{6,})/);
        return mm ? mm[1] : '';
      } catch (e) { return ''; }
    }
    let ytActiveFrame = null;
    function ytLoad(btn, id) {
      const card = btn.closest('.yt-embed');
      if (!card) return;
      if (ytActiveFrame && ytActiveFrame !== card) {
        ytActiveFrame.querySelectorAll('iframe').forEach(f => f.remove());
        ytActiveFrame.dataset.armed = '';
      }
      let f = card.querySelector('iframe');
      if (!f) {
        f = document.createElement('iframe');
        f.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
        f.allowFullscreen = true;
        card.insertBefore(f, card.firstChild);
      }
      f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&playsinline=1&rel=0';
      card.dataset.armed = '1';
      ytActiveFrame = card;
    }
    const YTTIME = /(\\?|&|t=)(\\d+h)?(\\d+m)?(\\d+s?)/;

"""

s = s.replace(js_anchor, YT_JS + js_anchor, 1)

# ============================================================
# 3) procTxt: classify youtube links as a 'yt' part + render card
# ============================================================
old_cls = """        if (isImgUrl(url)) parts.push({ t: 'img', v: url });
        else if (isVidUrl(url)) parts.push({ t: 'vid', v: url });"""
new_cls = """        if (ytId(url) && !isImgUrl(url)) parts.push({ t: 'yt', v: url });
        else if (isImgUrl(url)) parts.push({ t: 'img', v: url });
        else if (isVidUrl(url)) parts.push({ t: 'vid', v: url });"""
assert old_cls in s
s = s.replace(old_cls, new_cls, 1)

old_render = """        if (p.t === 'img') return `<img class="mimg" src="${ea(p.v)}" loading="lazy" onerror="this.style.display='none'" onclick="expandImg('${ea(p.v)}')" alt="[img]">`;"""
new_render = """        if (p.t === 'yt') {
          const yid = ytId(p.v);
          if (!yid) return `<a class="mlnk" href="${ea(p.v)}" target="_blank" rel="noopener noreferrer">${eh(p.v)}</a>`;
          const th = 'https://i.ytimg.com/vi/' + encodeURIComponent(yid) + '/mqdefault.jpg';
          return `<div class="yt-embed" data-yid="${eh(yid)}">` +
            `<button class="yt-thumb" style="background-image:url('${th}')" onclick="ytLoad(this,'${eh(yid)}')">` +
            `<span class="yt-meta"><span>YOUTUBE</span><span>TAP TO PLAY</span></span></button>` +
            `<span class="yt-title">${eh(p.v)}</span></div>`;
        }
        if (p.t === 'img') return `<img class="mimg" src="${ea(p.v)}" loading="lazy" onerror="this.style.display='none'" onclick="expandImg('${ea(p.v)}')" alt="[img]">`;"""
assert old_render in s
s = s.replace(old_render, new_render, 1)

# also render the card for image-caption-less image-only link classification
# (no change needed: 'yt' classification happens before img/vid tests)

# ============================================================
# 4) phone-only members button + drawer wiring
# ============================================================
# button next to the close btn in #cw titlebar
cw_btn_anchor = '<div class="tbbtn" onclick="returnToHome()" title="Return to Home">'
assert cw_btn_anchor in s
s = s.replace(cw_btn_anchor,
  '<div id="mbtn-phone" onclick="toggleMbrDrawer()" title="Members">\\u00b7\\u00b7\\u00b7</div>' + cw_btn_anchor, 1)

js_wire = """
    function toggleMbrDrawer() {
      const pan = document.querySelector('#cw .mbrpan');
      if (!pan) return;
      let scrim = document.querySelector('.mbdrop-scrim');
      if (!scrim) {
        scrim = document.createElement('div');
        scrim.className = 'mbdrop-scrim';
        scrim.onclick = () => toggleMbrDrawer();
        document.body.appendChild(scrim);
      }
      const open = pan.classList.toggle('mopen');
      scrim.style.display = open ? 'block' : 'none';
    }
"""
wire_anchor = "    function show(id) {"
assert wire_anchor in s
s = s.replace(wire_anchor, js_wire + wire_anchor, 1)

io.open(CHAT, "w", encoding="utf-8", newline="").write(s)
print("chat.html written:", len(s), "bytes")
print("phone css block:", "phone layout (<=700px)" in s)
print("yt helpers:", "function ytId" in s, "| yt part:", "'yt', v: url" in s)
print("drawer fn:", "function toggleMbrDrawer" in s, "| btn:", "mbtn-phone" in s)
