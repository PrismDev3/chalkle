/* Benign stub for the games235/gamemonetize ad SDK the compiled game tries to
   load. The real upstream file hijacks eval/location and redirects window.open
   to ad servers (and produced the file:// security errors). This stub keeps the
   same entry points as no-ops so the game runs clean with no ads. */
window.op3n = function () {};
window.l0cation = window.location;
window.wind0w = window;
window.SDK_OPTIONS = window.SDK_OPTIONS || {};
window.sdk = {
  showBanner: function () {},
  showInterstitial: function (cb) { if (typeof cb === 'function') cb(); },
  showRewarded: function (cb) { if (typeof cb === 'function') cb(); },
  onEvent: function () {},
  preloadAd: function () {},
  init: function () {},
  gameStart: function () {},
  gameEnd: function () {},
  load: function (cb) { if (typeof cb === 'function') cb(); }
};
