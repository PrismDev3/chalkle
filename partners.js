/* Partners library: admins add partners (name, icon, official link, discord
   invite) that everyone sees as cards - a square clickable icon, then the
   name, then an "Official link" button with the Discord button underneath.
   Self-contained, mirrors docs.js (same admin gate + localStorage pattern). */
(function () {
  "use strict";

  var STORE_KEY = "chalkle.partners.v1";
  var MAX_PARTNERS = 60;
  var MAX_ICON_BYTES = 900 * 1024; /* keep localStorage happy (data: URLs are chunky) */
  var ADMIN_KEY = "chalkle-admin-unlocked"; /* same key app.js uses for the admin panel */

  var state = { partners: [] };

  function isAdmin() {
    try { return localStorage.getItem(ADMIN_KEY) === "1"; } catch (e) { return false; }
  }

  /* ---------- persistence ---------- */

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) state.partners = parsed;
    } catch (e) {
      state.partners = [];
    }
  }

  function save() {
    try {
      var json = JSON.stringify(state.partners);
      if (json.length > 5 * 1024 * 1024) {
        var copy = state.partners.slice().sort(function (a, b) {
          return String(b.icon || "").length - String(a.icon || "").length;
        });
        while (copy.length && json.length > 5 * 1024 * 1024) {
          copy.pop();
          json = JSON.stringify(copy);
        }
        state.partners = copy;
      }
      localStorage.setItem(STORE_KEY, json);
    } catch (e) {
      notice("Storage full. Remove a partner or two.");
    }
  }

  /* ---------- helpers ---------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function normalizeUrl(s) {
    var t = String(s || "").trim();
    if (!t) return "";
    if (!/^https?:\/\//i.test(t)) t = "https://" + t;
    return t;
  }

  function timeAgo(ts) {
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return "just now";
    if (diff < 3600 * 1000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
  }

  function letterOf(name) {
    return String(name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  /* Relative icon paths ("assets/partners/x.webp") resolve against the site
     root on the normal server build but break on CDN/single-file origins.
     Normalize every stored icon to a leading-slash (site-absolute) path at
     render time - the single-file build inlines leading-slash asset paths as
     data URIs, and real origins serve /assets/... directly. */
  function iconSrc(ic) {
    ic = String(ic || "").trim();
    if (!ic) return "";
    if (/^(?:data:|https?:|blob:)/i.test(ic)) return ic;
    return ic.charAt(0) === "/" ? ic : "/" + ic;
  }

  function sorted() {
    return state.partners.slice().sort(function (a, b) {
      /* Partners with an official link come first; then the rest. Keeps the
         most "real" partners up top. Within each group, alphabetical. */
      var ao = normalizeUrl(a.official) ? 0 : 1;
      var bo = normalizeUrl(b.official) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return (a.name || "").localeCompare(b.name || "");
    });
  }

  /* ---------- rendering ---------- */

  function render() {
    var grid = document.getElementById("partners-grid");
    var count = document.getElementById("partners-count");
    var empty = document.getElementById("partners-empty");
    if (!grid) return;

    var partners = sorted();
    grid.innerHTML = "";

    if (count) count.textContent = partners.length + (partners.length === 1 ? " partner" : " partners");
    if (empty) empty.hidden = partners.length > 0;

    partners.forEach(function (p) {
      var official = normalizeUrl(p.official);
      var discord = normalizeUrl(p.discord);

      var card = el("div", "partner-card");
      card.dataset.id = p.id;

      /* Square clickable icon - opens the official link. */
      var iconWrap = el("a", "partner-icon-wrap");
      iconWrap.href = official || discord || "#";
      iconWrap.target = "_blank";
      iconWrap.rel = "noopener noreferrer";
      iconWrap.title = (p.name || "Partner") + (official ? " - official site" : "");
      var iconPath = iconSrc(p.icon);
      if (iconPath) {
        var img = document.createElement("img");
        img.className = "partner-icon";
        img.src = iconPath;
        img.alt = p.name || "Partner";
        img.loading = "lazy";
        iconWrap.appendChild(img);
      } else {
        var mono = el("span", "partner-icon partner-icon-mono", letterOf(p.name));
        iconWrap.appendChild(mono);
      }

      var name = el("div", "partner-name", p.name || "Partner");
      name.title = p.name || "";

      var btns = el("div", "partner-btns");
      if (official) {
        var aOff = document.createElement("a");
        aOff.className = "partner-btn partner-btn-off";
        aOff.href = official;
        aOff.target = "_blank";
        aOff.rel = "noopener noreferrer";
        aOff.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M10 14a4 4 0 0 0 6.3.8l3-3a4 4 0 0 0-5.6-5.6l-1.4 1.4"/>' +
          '<path d="M14 10a4 4 0 0 0-6.3-.8l-3 3a4 4 0 0 0 5.6 5.6l1.4-1.4"/>' +
          "</svg>Official link";
        btns.appendChild(aOff);
      } else {
        /* No official website yet: gray the play button out and say so. The
           Discord button below still works, so fans can join ahead of launch. */
        var offDis = el("span", "partner-btn partner-btn-off partner-coming", "Coming soon");
        offDis.title = "No official site yet - join their Discord below";
        btns.appendChild(offDis);
      }
      if (discord) {
        var aDisc = document.createElement("a");
        aDisc.className = "partner-btn partner-btn-disc";
        aDisc.href = discord;
        aDisc.target = "_blank";
        aDisc.rel = "noopener noreferrer";
        aDisc.innerHTML =
          '<svg class="icon disc-icon" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path fill="currentColor" stroke="none" d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.319 13.58.099 18.058a.082.082 0 0 0 .031.056c2.053 1.507 4.041 2.423 5.993 3.03a.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 13.11 13.11 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.076.076 0 0 0-.04.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029c1.961-.607 3.95-1.522 6.002-3.03a.077.077 0 0 0 .031-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.33c-1.183 0-2.157-1.086-2.157-2.42 0-1.333.956-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.956 2.42-2.157 2.42zm7.975 0c-1.183 0-2.157-1.086-2.157-2.42 0-1.333.956-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.946 2.42-2.157 2.42z"/>' +
          "</svg>Discord";
        btns.appendChild(aDisc);
      } else {
        var discDis = el("span", "partner-btn partner-btn-disc is-disabled", "Discord");
        btns.appendChild(discDis);
      }

      card.append(iconWrap, name, btns);

      /* Admins get edit + delete. */
      if (isAdmin()) {
        var meta = el("div", "partner-admin");
        var metaLeft = el("span", "partner-meta", timeAgo(p.created));
        var actions = el("div", "partner-admin-actions");
        var btnEdit = el("button", "partner-act", "Edit");
        var btnDel = el("button", "partner-act partner-act-danger", "Delete");
        actions.append(btnEdit, btnDel);
        meta.append(metaLeft, actions);
        card.appendChild(meta);
        btnEdit.addEventListener("click", function () { openModal(p); });
        btnDel.addEventListener("click", function () {
          if (!isAdmin()) return;
          if (!confirm('Remove "' + (p.name || "Partner") + '"?')) return;
          state.partners = state.partners.filter(function (x) { return x.id !== p.id; });
          save();
          render();
          notice('Removed "' + (p.name || "Partner") + '".');
        });
      }

      grid.appendChild(card);
    });
  }

  /* ---------- add / edit modal ---------- */

  function openModal(p) {
    if (!isAdmin()) { notice("Only admins can add partners."); return; }
    var modal = document.getElementById("partners-modal");
    var title = document.getElementById("partners-edit-title");
    var name = document.getElementById("partners-edit-name");
    var iconUrl = document.getElementById("partners-edit-icon-url");
    var iconImg = document.getElementById("partners-edit-icon-preview");
    var iconClear = document.getElementById("partners-edit-icon-clear");
    var official = document.getElementById("partners-edit-official");
    var discord = document.getElementById("partners-edit-discord");
    var saveBtn = document.getElementById("partners-edit-save");
    if (!modal || !name) return;

    modal.dataset.editId = p ? p.id : "";
    title.textContent = p ? "Edit partner" : "Add partner";
    name.value = p ? (p.name || "") : "";
    iconUrl.value = "";
    official.value = p ? (p.official || "") : "";
    discord.value = p ? (p.discord || "") : "";
    state.pendingIcon = p ? (p.icon || "") : "";

    var updatePreview = function () {
      var pendIcon = iconSrc(state.pendingIcon);
      iconImg.style.display = pendIcon ? "block" : "none";
      iconImg.src = pendIcon || "";
      iconClear.hidden = !state.pendingIcon;
    };
    updatePreview();

    modal.hidden = false;
    document.body.style.overflow = "hidden";
    name.focus();
  }

  function closeModal() {
    var modal = document.getElementById("partners-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    state.pendingIcon = "";
  }

  function onSave() {
    var name = document.getElementById("partners-edit-name");
    var official = document.getElementById("partners-edit-official");
    var discord = document.getElementById("partners-edit-discord");
    var modal = document.getElementById("partners-modal");
    if (!name || !modal) return;

    var nm = name.value.trim();
    if (!nm) { notice("Give the partner a name."); name.focus(); return; }
    var off = normalizeUrl(official.value);
    var disc = normalizeUrl(discord.value);
    if (!off && !disc) { notice("Add an official link or a Discord invite."); official.focus(); return; }

    var id = modal.dataset.editId;
    if (id) {
      var found = false;
      state.partners.forEach(function (p) {
        if (p.id === id) {
          p.name = nm;
          p.icon = state.pendingIcon || "";
          p.official = off;
          p.discord = disc;
          found = true;
        }
      });
      if (!found) id = "";
    }
    if (!id) {
      state.partners.push({
        id: uid(),
        name: nm,
        icon: state.pendingIcon || "",
        official: off,
        discord: disc,
        created: Date.now()
      });
      while (state.partners.length > MAX_PARTNERS) state.partners.shift();
    }

    save();
    closeModal();
    render();
    notice(id ? "Partner updated." : 'Added "' + nm + '".');
  }

  function handleIconFile(file) {
    if (!file) return;
    if (file.size > MAX_ICON_BYTES) { notice("Icon is too big. Keep it under 900 KB."); return; }
    var reader = new FileReader();
    reader.onload = function () {
      state.pendingIcon = String(reader.result || "");
      var img = document.getElementById("partners-edit-icon-preview");
      var clear = document.getElementById("partners-edit-icon-clear");
      if (img) { img.style.display = "block"; img.src = state.pendingIcon; }
      if (clear) clear.hidden = false;
    };
    reader.readAsDataURL(file);
  }

  function wireModal() {
    var modal = document.getElementById("partners-modal");
    if (!modal) return;

    var file = document.getElementById("partners-edit-icon-file");
    var urlInput = document.getElementById("partners-edit-icon-url");
    var applyUrl = document.getElementById("partners-edit-icon-apply");
    var clear = document.getElementById("partners-edit-icon-clear");
    var saveBtn = document.getElementById("partners-edit-save");
    var cancelBtn = document.getElementById("partners-edit-cancel");

    if (file) file.addEventListener("change", function () {
      if (file.files && file.files[0]) handleIconFile(file.files[0]);
      file.value = "";
    });
    if (applyUrl) applyUrl.addEventListener("click", function () {
      var u = normalizeUrl(urlInput.value);
      if (!u) return;
      state.pendingIcon = u;
      var img = document.getElementById("partners-edit-icon-preview");
      if (img) { img.style.display = "block"; img.src = u; }
      if (clear) clear.hidden = false;
      notice("Icon set from link.");
    });
    if (clear) clear.addEventListener("click", function () {
      state.pendingIcon = "";
      var img = document.getElementById("partners-edit-icon-preview");
      if (img) { img.style.display = "none"; img.src = ""; }
      clear.hidden = true;
    });
    if (saveBtn) saveBtn.addEventListener("click", onSave);
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
    modal.querySelectorAll("[data-partners-close]").forEach(function (n) {
      n.addEventListener("click", closeModal);
    });
    var name = document.getElementById("partners-edit-name");
    if (name) name.addEventListener("keydown", function (e) {
      if (e.key === "Enter") onSave();
    });
  }

  function notice(msg) {
    var n = document.createElement("div");
    n.className = "partners-toast";
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function () {
      n.classList.add("is-out");
      setTimeout(function () { n.remove(); }, 300);
    }, 2200);
  }

  /* Hide the add bar for regular users; they still see every partner. */
  function applyAdminUI() {
    var admin = isAdmin();
    var bar = document.querySelector(".partners-bar");
    if (bar) bar.hidden = true; /* add only via Settings admin menu */
    var modal = document.getElementById("partners-modal");
    if (modal && !admin) modal.hidden = true;
    var view = document.querySelector(".partners-view");
    if (view) {
      var hint = view.querySelector(".empty-hint");
      if (hint && hint.dataset.partnersHint === "add") {
        hint.textContent = admin
          ? "Add real partners with the bar above - name, icon, official link, and their Discord."
          : "Only admins can add partners. Everyone else can open their links and Discords.";
      }
    }
    render();
  }

  /* ---------- default partners (re-seeded if removed) ---------- */

  var DEFAULT_PARTNERS = [
    { name: "Kyro", official: "", discord: "https://discord.gg/cmAjzkYKTc", icon: "/assets/partners/kyro.png" },
    { name: "NEO OS", official: "https://n-xcsxzutr6punfhylgg3xfr5mp4lfywjjxzqtrfq-0lu-script.googleusercontent.com/userCodeAppPanel", discord: "https://discord.gg/4TjwQagfN", icon: "/assets/partners/neoos.jpg", renames: ["neoos"] },
    { name: "Godly Links", official: "", discord: "https://discord.gg/XZt4t8Jtk", icon: "/assets/partners/godlylinks.png" },
    { name: "Project Bugs", official: "https://sites.google.com/view/intresting-history-facts/home", discord: "https://discord.gg/m5B7munZvn", icon: "/assets/partners/projectbugs.jpg" },
    { name: "Frosted V2", official: "https://frostedbrowser.cfd/", discord: "https://discord.gg/w7J5auDhNm", icon: "/assets/partners/frosted.png", renames: ["frosted"] },
    { name: "P2P Games", official: "https://cdn.jsdelivr.net/gh/GreyLinks123/web-auto-1@main/web-fetch-1.svg", discord: "https://discord.gg/b6QRdA7bjR", icon: "/assets/partners/p2pgames.png" },
    { name: "S.V", official: "", discord: "https://discord.gg/FHmEqPgMVe", icon: "/assets/partners/sv.webp" },
    { name: "Anko", official: "https://anko-6116.logans.projectbyod.com/", discord: "https://discord.gg/anko", icon: "/assets/partners/anko.webp" },
    { name: "Ghost Proxy", official: "https://ghostub.surge.sh/", discord: "https://dsc.gg/ghostub", icon: "/assets/partners/ghostproxy.webp" }
  ];

  function seedDefaults() {
    var dirty = false;
    DEFAULT_PARTNERS.forEach(function (def) {
      var existing = null;
      for (var i = 0; i < state.partners.length; i++) {
        if (String(state.partners[i].name || "").trim().toLowerCase() === String(def.name).trim().toLowerCase()) {
          existing = state.partners[i];
          break;
        }
      }
      /* Default renamed (e.g. "Neoos" -> "NEO OS"): claim the old-titled copy
         and rename it in place so stored users don't end up with a duplicate. */
      if (!existing && def.renames) {
        for (var j = 0; j < state.partners.length; j++) {
          var oldName = String(state.partners[j].name || "").trim().toLowerCase();
          if (def.renames.indexOf(oldName) !== -1) {
            existing = state.partners[j];
            existing.name = def.name;
            dirty = true;
            break;
          }
        }
      }
      if (!existing) {
        state.partners.push({
          id: uid(),
          name: def.name,
          icon: def.icon || "",
          official: def.official || "",
          discord: def.discord || "",
          created: Date.now()
        });
        dirty = true;
      } else if (def.icon && !existing.icon) {
        /* Partner was seeded before the icon existed - backfill it now so
           already-stored copies pick up the new logo. */
        existing.icon = def.icon;
        dirty = true;
      } else if (def.official && !existing.official) {
        /* Partner was seeded before the site went live - backfill the
           official link so already-stored copies pick it up. */
        existing.official = def.official;
        dirty = true;
      }
    });
    if (dirty) save();
  }

  /* ---------- wiring ---------- */

  function init() {
    var grid = document.getElementById("partners-grid");
    if (!grid) return;

    load();
    seedDefaults();

    var addBtn = document.getElementById("partners-add");
    if (addBtn) addBtn.addEventListener("click", function () { openModal(null); });

    wireModal();
    applyAdminUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* Render the list of existing partners into the admin panel so an admin can
     edit or remove any partner from Settings. */
  function refreshAdminList() {
    var box = document.getElementById("admin-partners-list");
    if (!box) return;
    if (state.partners.length === 0) {
      box.innerHTML = "<p class=\"empty-hint\">No partners yet. Add one above.</p>";
      return;
    }
    var rows = [];
    state.partners.slice().sort(function (a, b) {
      return (a.name || "").localeCompare(b.name || "");
    }).forEach(function (p) {
      var row = document.createElement("div");
      row.className = "admin-lib-row";
      var grip = document.createElement("span");
      grip.className = "admin-lib-icon";
      grip.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>';
      var info = document.createElement("span");
      info.className = "admin-lib-name";
      info.textContent = p.name || "Partner";
      info.title = p.name || "";
      var tag = document.createElement("span");
      tag.className = "admin-lib-tag";
      tag.textContent = p.official ? "Official" : "Coming soon";
      var btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "btn-ghost admin-lib-edit";
      btnEdit.textContent = "Edit";
      btnEdit.addEventListener("click", function () { openModal(p); });
      row.append(grip, info, tag, btnEdit);
      rows.push(row);
    });
    box.innerHTML = "";
    rows.forEach(function (r) { box.appendChild(r); });
  }

  window.ChalklePartners = { render: render, refresh: render, applyAdminUI: applyAdminUI, addPartner: function () { openModal(null); }, editPartner: openModal, refreshAdminList: refreshAdminList };
})();
