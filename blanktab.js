/* Chalkle Blank Tab app. Standalone launcher: type any URL, pick how to open
   it (direct, about:blank, blob, in-app frame, or through a proxy) and launch.
   Own modal + own wiring - independent of the app shell. */

(function () {
  "use strict";

  function open() {
    var modal = document.getElementById("blanktab-modal");
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    var url = document.getElementById("blanktab-url");
    if (url) setTimeout(function () { url.focus(); }, 40);
  }

  function close() {
    var modal = document.getElementById("blanktab-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    var url = document.getElementById("blanktab-url");
    if (url) url.value = "";
  }

  function launch(url, mode) {
    var L = window.ChalkleLaunch;
    if (!L) return;
    if (mode === "iframe") {
      L.openIframe(url, url);
    } else if (mode === "proxy") {
      var proxies = typeof window.ChalkleGetProxies === "function" ? window.ChalkleGetProxies() : (window.ChalkleProxies || window.ChalkProxies || []);
      var p = (proxies || []).find(function (x) { return x.url; });
      if (!L.openProxy(url, p ? p.url : "")) alert("No proxy configured. Add one in the Proxies tab first.");
    } else if (mode === "aboutblank") {
      L.openAboutBlank(url, true);
    } else if (mode === "blob") {
      L.openBlob(url, true);
    } else if (mode === "dataurl") {
      L.openDataUrl(url);
    } else {
      L.openDirect(url);
    }
  }

  window.ChalkleBlankTab = {
    open: open,
    close: close,
    launch: launch
  };

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("blanktab-modal");
    if (!modal) return;

    modal.querySelectorAll("[data-blanktab-close]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target === el || el.tagName === "BUTTON") close();
      });
    });

    var form = document.getElementById("blanktab-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var url = document.getElementById("blanktab-url").value.trim();
      var mode = document.getElementById("blanktab-mode").value;
      if (!url) return;
      if (/^(file:|javascript:)/i.test(url)) {
        alert("Local file paths can't be opened from the site.");
        return;
      }
      if (url.indexOf("://") === -1) url = "https://" + url;
      close();
      launch(url, mode);
    });
  });
})();
