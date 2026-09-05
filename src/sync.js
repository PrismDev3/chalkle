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
      fetch('/_sync')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (dropThemes) {
            for (var i = 0; i < THEME_KEYS.length; i++) delete data[THEME_KEYS[i]];
          }
          var keys = Object.keys(data);
          for (var i = 0; i < keys.length; i++) {
            try { storage.setItem(keys[i], data[keys[i]]); } catch (e) {}
          }
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
