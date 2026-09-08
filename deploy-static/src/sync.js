(function() {
  var storage = null;
  try { storage = window.localStorage; } catch (e) {}

  /* Fetch the server-side saved state asynchronously - the old synchronous
     XMLHttpRequest on the main thread fires a deprecation warning (blocking
     the page on every load). Same result, no blocking. Uses the real
     localStorage.setItem (not the already-patched one below) so loading the
     saved state doesn't echo a write back to the server. */
  if (storage) {
    try {
      /* One-time migration (matches theme.js): older builds synced a theme the
         user never deliberately picked (a white/pink palette, candy wallpaper)
         up to the server, and this restore pushed it back onto every device on
         every load. If THIS device has not reset yet (local flag missing), drop
         the theme keys from whatever the server sends and mark the reset done -
         the flag then syncs back up so the server forgets the old palette for
         everyone. Uses THIS device's flag, not the server's: a device that
         already reset (local flag present) should still receive a theme the
         user picks later. Runs once per device. */
      var THEME_KEYS = ["chalkle-custom-theme", "chalkle-theme-preset", "chalkle-wallpaper"];
      /* Drop the synced theme keys when THIS session just auto-reset them
         (theme.js sets the marker right before this loads). Uses the in-session
         marker, not the stored flag: the flag exists on old devices too, but
         only a session that actually cleared the palette should suppress the
         server restore. After this one-time wipe, server copies get replaced
         by the clean state and normal syncing resumes. */
      var dropThemes = !!window.__chalkleThemeAutoReset;
      /* Library keys are seed-merged, never blindly overwritten: the seed in
         games.js / noah-games.js may be NEWER than the server snapshot (e.g. a
         newly imported catalog), and a blind restore would clobber it on every
         load, permanently hiding the new entries. Union by title: server copy
         first (keeps edits made on other devices), then local-only entries
         (fresh seeds + locally added items) appended. */
      var LIB_KEYS = { "chalkle-gamelib-v4": 1, "chalkle-sitelib-v2": 1, "chalkle-toollib-v6": 1, "chalkle-boardlib-v1": 1 };
      function mergeLib(serverVal, localVal) {
        try {
          var s = JSON.parse(serverVal), l = JSON.parse(localVal);
          if (!Array.isArray(s) || !Array.isArray(l)) return null;
          var byTitle = {}, out = [];
          s.forEach(function (it) { if (it && it.title && !(it.title in byTitle)) { byTitle[it.title] = it; out.push(it); } });
          l.forEach(function (it) {
            if (!it || !it.title) return;
            if (!(it.title in byTitle)) { byTitle[it.title] = it; out.push(it); }
            else {
              var hit = byTitle[it.title];
              /* A server row that lost its url is stale damage; the local
                 copy still knows where to launch. */
              if (!String(hit.url || "").trim() && String(it.url || "").trim()) {
                for (var i = 0; i < out.length; i++) { if (out[i] === hit) { out[i] = it; break; } }
              }
            }
          });
          return JSON.stringify(out);
        } catch (e) { return null; }
      }
      fetch('/_sync')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (dropThemes) {
            for (var i = 0; i < THEME_KEYS.length; i++) delete data[THEME_KEYS[i]];
          }
          var keys = Object.keys(data);
          for (var i = 0; i < keys.length; i++) {
            try {
              var k = keys[i];
              if (LIB_KEYS[k]) {
                var local = storage.getItem(k);
                var merged = local ? mergeLib(data[k], local) : null;
                storage.setItem(k, merged || data[k]);
              } else {
                storage.setItem(k, data[k]);
              }
            } catch (e) {}
          }
          /* The app may have already built its in-memory catalogs from the
             pre-restore state; let it re-read the libraries now that the
             server snapshot (and any fresh seeds preserved by the merge)
             has landed. */
          try { window.dispatchEvent(new CustomEvent("chalkle:sync-restored")); } catch (e) {}
        })
        .catch(function () {});
    } catch (e) {}
  }
  
  var origSet = localStorage.setItem;
  var origRemove = localStorage.removeItem;
  var origClear = localStorage.clear;
  
  var syncTimeout = null;
  function syncUp() {
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(function() {
      var d = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        d[k] = localStorage.getItem(k);
      }
      fetch('/_sync', { method: 'POST', body: JSON.stringify(d) }).catch(function(){});
    }, 500);
  }

  localStorage.setItem = function(k, v) {
    origSet.call(this, k, v);
    syncUp();
  };
  localStorage.removeItem = function(k) {
    origRemove.call(this, k);
    syncUp();
  };
  localStorage.clear = function() {
    origClear.call(this);
    syncUp();
  };
})();
