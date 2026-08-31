(function() {
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/_sync', false);
    xhr.send(null);
    if (xhr.status === 200) {
      var data = JSON.parse(xhr.responseText);
      var keys = Object.keys(data);
      if (keys.length > 0) {
        for (var i = 0; i < keys.length; i++) {
          localStorage.setItem(keys[i], data[keys[i]]);
        }
      }
    }
  } catch(e) {}
  
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
