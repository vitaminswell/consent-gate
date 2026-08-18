/* ============================================================
   CONSENT GATE
   ------------------------------------------------------------
   A first-party cookie consent gate for Webflow and other
   static sites. No dependencies, no build step on the consuming
   site, no subscription.

   Load it SYNCHRONOUSLY in the <head>, above every tracker:

     <script src="https://cdn.jsdelivr.net/gh/vitaminswell/consent-gate@v1.0.0/dist/consent-gate.min.js"
             data-cg-cookie="acme-consent"></script>

   Not async, not defer. That is not a style preference — the
   gate has to finish before the parser reaches the first embed,
   and its CSP fallback can only be written by a parser-blocking
   script. A footer-loaded consent banner is decorative: the
   cookies it claims to gate are already set by the time it runs.

   Three layers of blocking, because the obvious one is not
   sufficient on its own. See BLOCKING below.

   MIT licensed.
   ============================================================ */
(function (window, document) {
  "use strict";

  if (window.ConsentGate) return; // double-init guard

  var currentScript = document.currentScript;

  /* ---------------------------------------------------------
     DEFAULTS
     ------------------------------------------------------------
     Override wholesale by declaring window.ConsentGateConfig
     BEFORE this script, or per-key with data-cg-* attributes on
     the script tag itself.
     --------------------------------------------------------- */
  var DEFAULTS = {
    cookieName: "consent",

    // Stale consent is not consent. Six months is the common
    // compliant default; twelve is the outer limit most EU
    // regulators tolerate.
    lifetimeDays: 180,

    // Bump when the categories or their meaning change: stored
    // consent from an older version is discarded and re-asked.
    version: 1,

    // e.g. ".example.com" to share consent across subdomains.
    domain: null,

    // What the banner's X means. Treating dismissal as consent is
    // the most-cited dark pattern in EU enforcement, so the only
    // defensible values are "deny" or "none" (keep asking).
    closeMeans: "deny",

    // Category -> the Google Consent Mode v2 signals it governs.
    // Add, remove or rename freely; the UI is driven by whatever
    // keys exist here. "essential" is implicit and always granted.
    categories: {
      analytics: ["analytics_storage"],
      personalization: ["functionality_storage", "personalization_storage"],
      marketing: ["ad_storage", "ad_user_data", "ad_personalization"]
    },

    // Push Consent Mode signals at all. Turn off only if the site
    // has no Google tags whatsoever.
    consentMode: true,

    // Strip src from third-party embeds that were not tagged, so
    // an editor dropping a Vimeo block into the CMS cannot open a
    // pre-consent hole by accident.
    autoBlockEmbeds: true,

    // See BLOCKING. The CSP is the only embed block that cannot
    // lose a race; the cost is one reload when an embed category
    // is granted mid-session.
    hardBlockEmbeds: true,
    reloadOnEmbedGrant: true,

    // Frame sources the CSP must never block, whatever the consent
    // state. reCAPTCHA is strictly necessary for form submission.
    alwaysAllowedFrames: [
      "'self'",
      "https://www.google.com",
      "https://www.gstatic.com",
      "https://recaptcha.google.com"
    ],

    // Host fragment -> category, for autoBlockEmbeds.
    embedBlocklist: [
      ["youtube.com", "marketing"],
      ["youtube-nocookie.com", "marketing"],
      ["youtu.be", "marketing"],
      ["vimeo.com", "marketing"],
      ["player.vimeo.com", "marketing"],
      ["facebook.com", "marketing"],
      ["instagram.com", "marketing"],
      ["linkedin.com", "marketing"],
      ["spotify.com", "marketing"],
      ["soundcloud.com", "marketing"],
      ["google.com/maps", "personalization"],
      ["hubspot.com", "marketing"],
      ["typeform.com", "personalization"],
      ["calendly.com", "personalization"]
    ],

    // Everything user-visible that this script generates. The
    // banner and panel come from your own markup, so this is the
    // whole translation surface.
    text: {
      placeholder: "This content is hosted by a third party that sets cookies.",
      placeholderButton: "Allow and load",
      bannerLabel: "Cookie consent"
    }
  };

  /* ---------------------------------------------------------
     CONFIG RESOLUTION
     --------------------------------------------------------- */
  function readScriptConfig() {
    if (!currentScript) return {};
    var out = {};
    var map = {
      cookie: "cookieName",
      lifetime: "lifetimeDays",
      version: "version",
      domain: "domain",
      close: "closeMeans",
      categories: "categories",
      "consent-mode": "consentMode",
      "auto-block": "autoBlockEmbeds",
      "hard-block": "hardBlockEmbeds",
      reload: "reloadOnEmbedGrant"
    };
    for (var suffix in map) {
      var raw = currentScript.getAttribute("data-cg-" + suffix);
      if (raw === null) continue;
      var key = map[suffix];

      if (key === "categories") {
        // "analytics,marketing" keeps the default signal mapping
        // for known names and creates bare ones for the rest.
        var picked = {};
        raw.split(",").forEach(function (name) {
          name = name.trim();
          if (name) picked[name] = DEFAULTS.categories[name] || [];
        });
        out.categories = picked;
      } else if (key === "lifetimeDays" || key === "version") {
        out[key] = parseInt(raw, 10);
      } else if (
        key === "consentMode" ||
        key === "autoBlockEmbeds" ||
        key === "hardBlockEmbeds" ||
        key === "reloadOnEmbedGrant"
      ) {
        out[key] = raw !== "false";
      } else {
        out[key] = raw;
      }
    }
    return out;
  }

  function merge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var source = arguments[i] || {};
      for (var key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (key === "text") {
          out.text = merge(out.text || {}, source.text);
        } else if (source[key] !== undefined) {
          out[key] = source[key];
        }
      }
    }
    return out;
  }

  var CFG = merge(DEFAULTS, window.ConsentGateConfig, readScriptConfig());
  var CATEGORIES = Object.keys(CFG.categories);

  /* ---------------------------------------------------------
     STATE
     --------------------------------------------------------- */
  var state = {
    consent: null,      // null = undecided
    decidedAt: null,    // unix seconds — the audit trail
    ready: false,
    observer: null,
    cspActive: false,
    lastFocus: null,
    els: {}
  };

  function blankConsent(value) {
    var out = {};
    for (var i = 0; i < CATEGORIES.length; i++) out[CATEGORIES[i]] = value ? 1 : 0;
    return out;
  }

  function cloneConsent(consent) {
    var out = {};
    for (var i = 0; i < CATEGORIES.length; i++) {
      out[CATEGORIES[i]] = consent && consent[CATEGORIES[i]] ? 1 : 0;
    }
    return out;
  }

  function granted(category) {
    if (category === "essential") return true;
    return !!(state.consent && state.consent[category]);
  }

  /* ---------------------------------------------------------
     STORAGE
     ------------------------------------------------------------
     One first-party cookie rather than localStorage: readable by
     the server if a tag ever needs gating server-side, and it
     expires on its own instead of living forever.
     --------------------------------------------------------- */
  function readCookie() {
    var match = document.cookie.match(
      new RegExp("(?:^|; )" + CFG.cookieName + "=([^;]*)")
    );
    if (!match) return null;
    try {
      var data = JSON.parse(decodeURIComponent(match[1]));
      if (!data || data.v !== CFG.version || !data.c) return null;
      if ((Date.now() / 1000 - (data.t || 0)) / 86400 > CFG.lifetimeDays) return null;
      state.decidedAt = data.t;
      return cloneConsent(data.c);
    } catch (err) {
      return null;
    }
  }

  function writeCookie(consent) {
    var now = Math.round(Date.now() / 1000);
    var parts = [
      CFG.cookieName +
        "=" +
        encodeURIComponent(JSON.stringify({ v: CFG.version, t: now, c: consent })),
      "path=/",
      "max-age=" + CFG.lifetimeDays * 86400,
      "SameSite=Lax"
    ];
    if (CFG.domain) parts.push("domain=" + CFG.domain);
    if (location.protocol === "https:") parts.push("Secure");
    document.cookie = parts.join("; ");
    state.decidedAt = now;
  }

  function clearCookie() {
    var parts = [CFG.cookieName + "=", "path=/", "max-age=0"];
    if (CFG.domain) parts.push("domain=" + CFG.domain);
    document.cookie = parts.join("; ");
  }

  /* ---------------------------------------------------------
     GOOGLE CONSENT MODE v2
     ------------------------------------------------------------
     Runs before GTM exists. gtag() only queues into dataLayer, so
     the default lands ahead of the container and GTM reads it the
     moment it boots — which is why GTM itself needs no tagging.
     --------------------------------------------------------- */
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  if (!window.gtag) window.gtag = gtag;

  function consentModeSignals(consent) {
    var signals = { security_storage: "granted" }; // never optional
    for (var i = 0; i < CATEGORIES.length; i++) {
      var category = CATEGORIES[i];
      var value = consent && consent[category] ? "granted" : "denied";
      var keys = CFG.categories[category] || [];
      for (var k = 0; k < keys.length; k++) signals[keys[k]] = value;
    }
    return signals;
  }

  function pushConsentMode(type, consent) {
    if (CFG.consentMode) {
      var signals = consentModeSignals(consent);
      if (type === "default") {
        signals.wait_for_update = 500;
        gtag("consent", "default", signals);
      } else {
        gtag("consent", "update", signals);
      }
    }
    window.dataLayer.push({
      event: "consent_gate_" + (type === "default" ? "default" : "update"),
      consent: consent || blankConsent(0)
    });
  }

  /* ---------------------------------------------------------
     BLOCKING — layer 2: scripts
     ------------------------------------------------------------
     Tagged scripts ship as type="text/plain" so the parser will
     not execute them. Granting swaps in a real <script>; changing
     the type alone does not re-trigger execution.
     --------------------------------------------------------- */
  function unblockScripts() {
    var nodes = document.querySelectorAll(
      'script[type="text/plain"][data-cc-category]'
    );
    for (var i = 0; i < nodes.length; i++) {
      var old = nodes[i];
      if (!granted(old.getAttribute("data-cc-category"))) continue;

      var fresh = document.createElement("script");
      for (var a = 0; a < old.attributes.length; a++) {
        var attr = old.attributes[a];
        if (attr.name === "type" || attr.name.indexOf("data-cc-") === 0) continue;
        fresh.setAttribute(attr.name, attr.value);
      }
      var src = old.getAttribute("data-cc-src");
      if (src) fresh.src = src;
      else fresh.text = old.textContent;

      old.parentNode.replaceChild(fresh, old);
    }
  }

  /* ---------------------------------------------------------
     BLOCKING — layer 3: embeds
     --------------------------------------------------------- */
  function categoryForUrl(url) {
    if (!url) return null;
    for (var i = 0; i < CFG.embedBlocklist.length; i++) {
      if (url.indexOf(CFG.embedBlocklist[i][0]) !== -1) return CFG.embedBlocklist[i][1];
    }
    return null;
  }

  // Called from the MutationObserver, potentially before the node
  // is in the document.
  function guardIframe(frame) {
    if (frame.hasAttribute("data-cc-src")) return; // already tagged
    if (!CFG.autoBlockEmbeds) return;

    var src = frame.getAttribute("src");
    var category = categoryForUrl(src);
    if (!category || granted(category)) return;

    frame.setAttribute("data-cc-src", src);
    frame.setAttribute("data-cc-category", category);
    frame.setAttribute("data-cc-auto", "");
    frame.removeAttribute("src");

    // unblockIframes() only sweeps once, at DOMContentLoaded. An
    // iframe guarded after that — because the observer callback
    // landed late, or because a slider injected it minutes later —
    // would otherwise sit there blocked with nothing explaining why.
    if (state.ready && frame.parentNode) addPlaceholder(frame, category);
  }

  function unblockIframes() {
    var frames = document.querySelectorAll("iframe[data-cc-src]");
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var category = frame.getAttribute("data-cc-category") || CATEGORIES[0];
      if (!granted(category)) {
        addPlaceholder(frame, category);
        continue;
      }
      removePlaceholder(frame);
      if (!frame.getAttribute("src")) {
        frame.setAttribute("src", frame.getAttribute("data-cc-src"));
      }
    }
  }

  function addPlaceholder(frame, category) {
    var prev = frame.previousElementSibling;
    if (prev && prev.hasAttribute("data-cc-placeholder")) return;

    var box = document.createElement("div");
    box.setAttribute("data-cc-placeholder", category);

    var text = document.createElement("p");
    text.setAttribute("data-cc-placeholder-text", "");
    text.textContent = CFG.text.placeholder;

    var button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-cc-placeholder-button", "");
    button.textContent = CFG.text.placeholderButton;
    button.addEventListener("click", function () {
      // Consent for one embed is consent for its whole category —
      // pretending otherwise would misrepresent what is stored.
      var next = cloneConsent(state.consent);
      next[category] = 1;
      apply(next, "placeholder");
    });

    box.appendChild(text);
    box.appendChild(button);
    frame.parentNode.insertBefore(box, frame);
    frame.setAttribute("data-cc-blocked", "");
  }

  function removePlaceholder(frame) {
    var prev = frame.previousElementSibling;
    if (prev && prev.hasAttribute("data-cc-placeholder")) prev.remove();
    frame.removeAttribute("data-cc-blocked");
  }

  /* ---------------------------------------------------------
     CRITICAL CSS
     ------------------------------------------------------------
     Injected rather than shipped as a stylesheet so installing is
     a single script tag. It must land before first paint or the
     banner flashes for people who already decided, which rules
     out appending it at DOMContentLoaded.

     Note it hides via [hidden] rather than a display rule, so the
     site's own layout classes stay in charge once shown.
     --------------------------------------------------------- */
  function injectCriticalCss() {
    var css =
      '[data-cc="banner"],[data-cc="preferences"],[data-cc="manager"]{visibility:hidden}' +
      'html.cc-ready [data-cc="banner"],html.cc-ready [data-cc="preferences"],' +
      'html.cc-ready [data-cc="manager"]{visibility:visible}' +
      "[data-cc][hidden]{display:none!important}" +
      "html[data-cc-scroll-lock],html[data-cc-scroll-lock] body{overflow:hidden}" +
      "iframe[data-cc-blocked]{display:none!important}";

    if (document.readyState === "loading") {
      document.write("<style>" + css + "</style>");
    } else {
      var style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  /* ---------------------------------------------------------
     BLOCKING — layer 1: parser-time CSP
     ------------------------------------------------------------
     The MutationObserver below removes an untagged embed's src,
     but the browser has already dispatched the request by the
     time the callback runs. That is measured, not assumed — see
     test/verify.js, "no embed is fetched before consent".

     So while the embed categories are denied we also emit a CSP
     the network stack enforces, which cannot race. A meta CSP is
     ignored unless the parser sees it, hence document.write, and
     it cannot be relaxed afterwards, hence the reload on grant.
     --------------------------------------------------------- */
  function embedCategories() {
    var seen = {};
    for (var i = 0; i < CFG.embedBlocklist.length; i++) seen[CFG.embedBlocklist[i][1]] = true;
    return Object.keys(seen);
  }

  function anyEmbedCategoryGranted(consent) {
    return embedCategories().some(function (category) {
      return consent && consent[category];
    });
  }

  function hardBlockFrames() {
    if (!CFG.hardBlockEmbeds) return;
    if (document.readyState !== "loading") return; // too late to matter
    if (anyEmbedCategoryGranted(state.consent)) return;

    document.write(
      '<meta http-equiv="Content-Security-Policy" content="frame-src ' +
        CFG.alwaysAllowedFrames.join(" ") +
        '">'
    );
    state.cspActive = true;
  }

  function needsReloadFor(consent) {
    if (!state.cspActive || !CFG.reloadOnEmbedGrant) return false;
    if (!anyEmbedCategoryGranted(consent)) return false;
    return !!document.querySelector("iframe[data-cc-src]");
  }

  /* ---------------------------------------------------------
     EARLY OBSERVER
     ------------------------------------------------------------
     Starts before <body> exists. Best-effort by nature (see
     above) — the CSP is what actually guarantees the block.
     --------------------------------------------------------- */
  function startObserver() {
    if (!window.MutationObserver || state.observer) return;
    state.observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== 1) continue;
          if (node.tagName === "IFRAME") guardIframe(node);
          else if (node.querySelectorAll) {
            var nested = node.querySelectorAll("iframe");
            for (var i = 0; i < nested.length; i++) guardIframe(nested[i]);
          }
        }
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------
     UI
     --------------------------------------------------------- */
  function show(el) {
    if (el) el.removeAttribute("hidden");
  }
  function hide(el) {
    if (el) el.setAttribute("hidden", "");
  }

  function openPreferences() {
    state.lastFocus = document.activeElement;
    syncCheckboxes();
    show(state.els.prefs);
    hide(state.els.banner);
    if (state.els.prefs) {
      state.els.prefs.setAttribute("aria-hidden", "false");
      document.documentElement.setAttribute("data-cc-scroll-lock", "");
      focusFirst(state.els.prefs);
    }
  }

  function closePreferences() {
    hide(state.els.prefs);
    if (state.els.prefs) state.els.prefs.setAttribute("aria-hidden", "true");
    document.documentElement.removeAttribute("data-cc-scroll-lock");
    if (!state.consent) show(state.els.banner); // still undecided
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  var FOCUSABLE =
    'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

  function focusFirst(container) {
    var target = container.querySelector(FOCUSABLE);
    if (target && target.focus) target.focus();
  }

  function trapFocus(event) {
    var prefs = state.els.prefs;
    if (!prefs || prefs.hasAttribute("hidden")) return;

    if (event.key === "Escape") return closePreferences();
    if (event.key !== "Tab") return;

    var all = prefs.querySelectorAll(FOCUSABLE);
    var visible = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent !== null || all[i].type === "checkbox") visible.push(all[i]);
    }
    if (!visible.length) return;

    var first = visible[0];
    var last = visible[visible.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function syncCheckboxes() {
    var boxes = document.querySelectorAll("[data-cc-checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      // Never pre-ticked. A pre-ticked box is not consent.
      boxes[i].checked = granted(boxes[i].getAttribute("data-cc-checkbox"));
      reflectCustomCheckbox(boxes[i]);
    }
  }

  // Webflow paints its custom checkbox on a sibling div rather than
  // the real input, so the visual state has to be pushed manually.
  function reflectCustomCheckbox(input) {
    var custom = input.previousElementSibling;
    while (custom && String(custom.className).indexOf("w-checkbox-input") === -1) {
      custom = custom.previousElementSibling;
    }
    if (custom) custom.classList.toggle("w--redirected-checked", input.checked);

    var wrap = input.closest ? input.closest("[data-cc-toggle]") : null;
    if (wrap) wrap.setAttribute("data-cc-checked", input.checked ? "true" : "false");
  }

  function readCheckboxes() {
    var consent = blankConsent(0);
    var boxes = document.querySelectorAll("[data-cc-checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      var category = boxes[i].getAttribute("data-cc-checkbox");
      if (CATEGORIES.indexOf(category) !== -1) consent[category] = boxes[i].checked ? 1 : 0;
    }
    return consent;
  }

  /* ---------------------------------------------------------
     APPLY
     ------------------------------------------------------------
     The single funnel every decision passes through, so storage,
     Consent Mode, unblocking and UI can never drift apart.
     --------------------------------------------------------- */
  function apply(consent, source) {
    state.consent = cloneConsent(consent);
    writeCookie(state.consent);
    pushConsentMode("update", state.consent);
    unblockScripts();

    var reload = needsReloadFor(state.consent);
    if (!reload) unblockIframes();
    renderUI();

    document.dispatchEvent(
      new CustomEvent("consentgate:change", {
        detail: {
          consent: cloneConsent(state.consent),
          source: source || "unknown",
          decidedAt: state.decidedAt,
          reloading: reload
        }
      })
    );

    if (reload) location.reload(); // last, so listeners still run
  }

  function renderUI() {
    if (!state.ready) return;
    if (state.consent) {
      hide(state.els.banner);
      show(state.els.manager);
    } else {
      show(state.els.banner);
      hide(state.els.manager);
    }
    hide(state.els.prefs);
    if (state.els.prefs) state.els.prefs.setAttribute("aria-hidden", "true");
    document.documentElement.removeAttribute("data-cc-scroll-lock");
  }

  /* ---------------------------------------------------------
     BINDING
     --------------------------------------------------------- */
  function bind() {
    state.els.banner = document.querySelector('[data-cc="banner"]');
    state.els.prefs = document.querySelector('[data-cc="preferences"]');
    state.els.manager = document.querySelector('[data-cc="manager"]');

    // Hide all three before the stylesheet's visibility guard
    // lifts, or the banner flashes for people who already decided.
    hide(state.els.banner);
    hide(state.els.prefs);
    hide(state.els.manager);

    if (state.els.prefs) {
      state.els.prefs.setAttribute("role", "dialog");
      state.els.prefs.setAttribute("aria-modal", "true");
      state.els.prefs.setAttribute("aria-hidden", "true");

      // Webflow wraps the panel in a form; Enter must not navigate.
      var form = state.els.prefs.querySelector("form");
      if (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          apply(readCheckboxes(), "preferences");
        });
      }
    }
    if (state.els.banner) {
      state.els.banner.setAttribute("role", "region");
      state.els.banner.setAttribute("aria-label", CFG.text.bannerLabel);
    }

    document.addEventListener("click", function (event) {
      var trigger = event.target.closest ? event.target.closest("[data-cc]") : null;
      if (!trigger) return;

      switch (trigger.getAttribute("data-cc")) {
        case "allow":
          event.preventDefault();
          apply(blankConsent(1), "banner-accept");
          break;
        case "deny":
          event.preventDefault();
          apply(blankConsent(0), "banner-reject");
          break;
        case "submit":
          event.preventDefault();
          apply(readCheckboxes(), "preferences");
          break;
        case "open-preferences":
          event.preventDefault();
          openPreferences();
          break;
        case "close":
          event.preventDefault();
          if (!state.els.prefs || state.els.prefs.hasAttribute("hidden")) {
            if (CFG.closeMeans === "deny") apply(blankConsent(0), "banner-close");
            else hide(state.els.banner);
          } else {
            closePreferences();
          }
          break;
      }
    });

    document.addEventListener("change", function (event) {
      if (event.target.hasAttribute && event.target.hasAttribute("data-cc-checkbox")) {
        reflectCustomCheckbox(event.target);
      }
    });

    document.addEventListener("keydown", trapFocus);

    state.ready = true;
    document.documentElement.classList.add("cc-ready");
  }

  /* ---------------------------------------------------------
     PUBLIC API
     --------------------------------------------------------- */
  window.ConsentGate = {
    config: CFG,
    categories: CATEGORIES.slice(),
    get: function () {
      return state.consent ? cloneConsent(state.consent) : null;
    },
    has: granted,
    decidedAt: function () {
      return state.decidedAt;
    },
    acceptAll: function () {
      apply(blankConsent(1), "api");
    },
    rejectAll: function () {
      apply(blankConsent(0), "api");
    },
    set: function (partial) {
      var next = cloneConsent(state.consent);
      for (var key in partial) {
        if (CATEGORIES.indexOf(key) !== -1) next[key] = partial[key] ? 1 : 0;
      }
      apply(next, "api");
    },
    open: openPreferences,
    close: closePreferences,
    reset: function () {
      clearCookie();
      state.consent = null;
      state.decidedAt = null;
      renderUI();
    }
  };

  /* ---------------------------------------------------------
     BOOT
     --------------------------------------------------------- */
  state.consent = readCookie();

  // Defaults must be declared even when consent already exists —
  // GTM expects 'default' first and 'update' second.
  pushConsentMode("default", null);
  if (state.consent) pushConsentMode("update", state.consent);

  injectCriticalCss();
  hardBlockFrames();
  startObserver();

  function onReady() {
    bind();
    unblockScripts();
    unblockIframes();
    renderUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})(window, document);
