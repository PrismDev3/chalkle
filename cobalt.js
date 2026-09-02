(function () {
  "use strict";
  function init() {
    var form = document.getElementById("cobalt-form");
    if (!form) return;
    var input = document.getElementById("cobalt-url");
    var status = document.getElementById("cobalt-status");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = String(input && input.value || "").trim();
      if (!/^https?:\/\//i.test(value)) {
        if (status) status.textContent = "Paste a complete http or https link.";
        return;
      }
      if (status) status.textContent = "Opening Cobalt...";
      window.open("https://cobalt.tools/?url=" + encodeURIComponent(value), "_blank", "noopener,noreferrer");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
