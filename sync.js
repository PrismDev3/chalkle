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
      fetch('/_sync')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
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
