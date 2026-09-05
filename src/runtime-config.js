// Runtime deployment configuration. A static mirror can optionally provide
// its production API origin through a meta tag or window.CHALKLE_API_ROOT.
// Keep this file free of temporary tunnel URLs so a deployment can change
// hosts without a frontend rebuild.
(function () {
  "use strict";
  function configuredRoot() {
    var value = window.CHALKLE_API_ROOT || "";
    var meta = document.querySelector('meta[name="chalkle-api-root"]');
    if (!value && meta) value = meta.getAttribute("content") || "";
    return String(value).trim().replace(/\/+$/, "");
  }
  /* Static mirrors cannot execute the Chalkle relay themselves. Keep the
     public first-party relay as the default API origin so jsDelivr/GitHub
     mirrors still have working cloud, music, live data and proxy routes. */
  var main = configuredRoot() || "https://chalkle.lootline.xyz";
  window.SCHOOL_CENTER_CONFIG = {
    mainUrl: main,
    generatedAt: "2026-09-01"
  };

  function isMirror() {
    if (window.__CHALKLE_EMBED__) return true;
    try {
      if (location.protocol === "file:" || location.origin === "null") return true;
      var host = String(location.hostname || "");
      return /(?:^|\.)(?:jsdelivr\.net|githack\.com|unpkg\.com|github\.io|pages\.dev|gitlab\.io|githubusercontent\.com)$/i.test(host);
    } catch (e) {
      return false;
    }
  }

  function root() {
    if (!isMirror()) return "";
    return main;
  }

  window.ChalkleApi = {
    isMirror: isMirror,
    root: root,
    url: function (path) {
      path = String(path || "");
      if (!path) return root();
      if (/^https?:/i.test(path)) return path;
      if (path.charAt(0) !== "/") path = "/" + path;
      return root() + path;
    },
    host: function () {
      var r = root();
      if (!r) {
        try { return location.host; } catch (e) { return ""; }
      }
      try { return new URL(r).host; } catch (e) { return ""; }
    }
  };
})();
