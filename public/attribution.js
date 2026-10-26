// GBK Composer ad attribution (#131): first-touch UTM + click ids, kept site-wide.
// Loaded by every page (SPA shell + server-rendered pages) so an ad landing on /chatgpt, /s/<slug>,
// /feed or anywhere else is still credited when the visitor reaches the /pricing paywall later.
// Storage: one first-party cookie per key (gbk_utm_source, ..., gbk_twclid, gbk_rdt_cid, gbk_landing),
// Path=/, 30 days, first-touch wins (an existing cookie is never overwritten). sessionStorage mirrors
// the same gbk_<key> values the old /pricing-only snippet used, so same-session behavior is unchanged.
// Nothing is stored when the browser sends Global Privacy Control or Do Not Track.
// On /pricing it also fills each Buy form (form[data-checkout]) right before submit with the stored
// ids + a fresh event_id, and remembers the checkout in localStorage for the /pricing/thanks pixels.
(function () {
  try {
    var K = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "twclid", "rdt_cid"];
    var n = navigator, optOut = !!(n.globalPrivacyControl || n.doNotTrack === "1" || window.doNotTrack === "1");
    var MAXAGE = 2592000; // 30 days, in seconds
    var store = null; try { store = sessionStorage; } catch (e) { /* storage blocked: cookie only */ }
    function readCookie(k) {
      var m = document.cookie.match(new RegExp("(?:^|; )gbk_" + k + "=([^;]*)"));
      if (!m) return null;
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    function writeCookie(k, v) {
      document.cookie = "gbk_" + k + "=" + encodeURIComponent(v) + "; Path=/; Max-Age=" + MAXAGE + "; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
    }
    // First-touch value for a key: the durable cookie wins, then this session's mirror, then the URL.
    function firstTouch(k, fromUrl) {
      return readCookie(k) || (store && store.getItem("gbk_" + k)) || fromUrl || null;
    }
    if (!optOut) {
      var q = new URLSearchParams(location.search);
      K.forEach(function (k) {
        var v = q.get(k);
        var cur = firstTouch(k, v ? v.slice(0, 200) : null);
        if (!cur) return;
        if (!readCookie(k)) writeCookie(k, cur);
        try { store && store.setItem("gbk_" + k, cur); } catch (e) { /* ignore */ }
      });
      var landing = firstTouch("landing", location.href.slice(0, 300));
      if (landing) {
        if (!readCookie("landing")) writeCookie("landing", landing);
        try { store && store.setItem("gbk_landing", landing); } catch (e) { /* ignore */ }
      }
    }
    function stored(k) { return optOut ? null : firstTouch(k, null); }
    function fillForms() {
      document.querySelectorAll("form[data-checkout]").forEach(function (f) {
        f.addEventListener("submit", function () {
          var id = "gc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
          var put = function (k, v) {
            if (!v) return;
            var i = f.querySelector('input[name="' + k + '"]') || f.appendChild(Object.assign(document.createElement("input"), { type: "hidden", name: k }));
            i.value = v;
          };
          put("event_id", id);
          K.forEach(function (k) { put(k, stored(k)); });
          put("landing", stored("landing"));
          if (optOut || f.dataset.ads === "0") put("ads_opt_out", "1");
          try { localStorage.setItem("gbk_checkout", JSON.stringify({ id: id, plan: f.querySelector('input[name="plan"]').value, at: Date.now() })); } catch (e) { /* ignore */ }
        });
      });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fillForms); else fillForms();
  } catch (e) { /* attribution must never break a page */ }
})();
