/* ============================================================
   VERIFIER — Consent Gate
   ------------------------------------------------------------
   Binary pass/fail. Every assertion maps to a compliance claim
   or a documented behaviour; nothing here is cosmetic.

   Run: node test/verify.js
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
let requestLog = [];

/* ---------- fixture server ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  requestLog.push(url);

  if (url === "/" || url === "/harness.html") {
    // Embeds are served from a different host than the page so that
    // the CSP's 'self' does not accidentally whitelist them — same
    // relationship as vimeo.com to obel.foundation.
    // ?visible=1 serves the visibleClass variant: display:none on the
    // base selector (the "invisible in the Designer" setup) with the
    // real display carried by an is-visible combo class.
    const variant = /[?&]visible=1/.test(req.url);
    const html = fs
      .readFileSync(path.join(__dirname, "harness.html"), "utf8")
      .replace(/__EMBED_ORIGIN__/g, `http://localhost:${server.address().port}`)
      .replace("__CG_ATTRS__", variant ? ' data-cg-visible-class="is-visible"' : "")
      .replace(
        "__CG_BASE_CSS__",
        variant
          ? '[data-cc="banner"],[data-cc="preferences"],[data-cc="manager"]{display:none}\n' +
            '  [data-cc].is-visible{display:block}'
          : '[data-cc="banner"],[data-cc="preferences"],[data-cc="manager"]{display:block}'
      );
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }
  if (url === "/consent-gate.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    // MIN=1 runs the whole suite against the shipped, minified
    // bundle instead of the source — the CDN file is what has to work.
    if (process.env.MIN) {
      return res.end(fs.readFileSync(path.join(ROOT, "dist", "consent-gate.min.js")));
    }
    return res.end(fs.readFileSync(path.join(ROOT, "src", "consent-gate.js")));
  }
  if (url.startsWith("/tags/")) {
    const name = url.includes("analytics") ? "Analytics" : "Marketing";
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(`window.__ran${name}External = true;`);
  }
  if (url.startsWith("/embeds/")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<!doctype html><title>embed</title>embed");
  }
  res.writeHead(404).end();
});

/* ---------- assertions ---------- */
let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
  } else {
    failures.push({ name, detail });
  }
}

// Key order is an implementation detail — the signal set is built
// by iterating a config object, so sort before comparing.
function stable(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => ((out[key] = stable(value[key])), out), {});
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(stable(actual)) === JSON.stringify(stable(expected));
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ---------- page helpers ---------- */
const BASE = () => `http://127.0.0.1:${server.address().port}/harness.html`;

async function freshPage(browser, cookies) {
  const context = await browser.newContext();
  if (cookies) await context.addCookies(cookies);
  const page = await context.newPage();
  requestLog = [];
  await page.goto(BASE(), { waitUntil: "networkidle" });
  return { context, page };
}

const flags = (page) =>
  page.evaluate(() => ({
    analyticsInline: !!window.__ranAnalyticsInline,
    analyticsExternal: !!window.__ranAnalyticsExternal,
    marketingExternal: !!window.__ranMarketingExternal,
    personalization: !!window.__ranPersonalization
  }));

const visible = (page) =>
  page.evaluate(() => {
    const at = (sel) => {
      const el = document.querySelector(sel);
      return el ? !el.hasAttribute("hidden") : null;
    };
    return {
      banner: at('[data-cc="banner"]'),
      prefs: at('[data-cc="preferences"]'),
      manager: at('[data-cc="manager"]')
    };
  });

const storedConsent = async (context, name = "cg-test") => {
  const all = await context.cookies();
  const found = all.find((c) => c.name === name);
  return found ? JSON.parse(decodeURIComponent(found.value)) : null;
};

// Last consent 'default' or 'update' call recorded in dataLayer.
const consentSignal = (page, kind) =>
  page.evaluate((k) => {
    const hits = (window.dataLayer || []).filter(
      (entry) => entry && entry[0] === "consent" && entry[1] === k
    );
    if (!hits.length) return null;
    return Object.assign({}, hits[hits.length - 1][2]);
  }, kind);

function cookieFor(consent, { ageDays = 0, version = 1 } = {}) {
  const payload = {
    v: version,
    t: Math.round(Date.now() / 1000) - Math.round(ageDays * 86400),
    c: consent
  };
  return [
    {
      name: "cg-test",
      value: encodeURIComponent(JSON.stringify(payload)),
      domain: "127.0.0.1",
      path: "/"
    }
  ];
}

/* ---------- suite ---------- */
async function run() {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  });

  /* === 1. FIRST VISIT: nothing may fire === */
  {
    const { context, page } = await freshPage(browser);

    eq("first visit shows banner only", await visible(page), {
      banner: true,
      prefs: false,
      manager: false
    });

    eq("no tracker executes before consent", await flags(page), {
      analyticsInline: false,
      analyticsExternal: false,
      marketingExternal: false,
      personalization: false
    });

    check(
      "no tracker file is even requested",
      !requestLog.some((u) => u.startsWith("/tags/")),
      `requested: ${requestLog.filter((u) => u.startsWith("/tags/")).join(", ")}`
    );

    eq("Consent Mode defaults are denied", await consentSignal(page, "default"), {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied",
      functionality_storage: "denied",
      personalization_storage: "denied",
      security_storage: "granted",
      wait_for_update: 500
    });

    check("no consent cookie is written before a choice", (await storedConsent(context)) === null);

    // embeds
    const embeds = await page.evaluate(() => ({
      manualSrc: document.getElementById("embed-manual").getAttribute("src"),
      autoSrc: document.getElementById("embed-auto").getAttribute("src"),
      autoStashed: document.getElementById("embed-auto").getAttribute("data-cc-src"),
      placeholders: document.querySelectorAll("[data-cc-placeholder]").length
    }));
    check("manually tagged embed has no src", embeds.manualSrc === null, `src=${embeds.manualSrc}`);
    check("untagged embed is auto-stripped", embeds.autoSrc === null, `src=${embeds.autoSrc}`);
    check(
      "untagged embed src is stashed for later",
      !!embeds.autoStashed,
      `data-cc-src=${embeds.autoStashed}`
    );
    check("both blocked embeds get a placeholder", embeds.placeholders === 2, `got ${embeds.placeholders}`);
    check(
      "no embed is fetched before consent",
      !requestLog.some((u) => u.startsWith("/embeds/")),
      `requested: ${requestLog.filter((u) => u.startsWith("/embeds/")).join(", ")}`
    );

    const csp = await page.evaluate(() => {
      const meta = document.querySelector(
        'meta[http-equiv="Content-Security-Policy"]'
      );
      return meta ? meta.getAttribute("content") : null;
    });
    check("a parser-time CSP backs up the JS block", !!csp && csp.indexOf("frame-src") === 0, `csp=${csp}`);
    check(
      "the CSP still permits reCAPTCHA frames",
      !!csp && csp.indexOf("https://www.google.com") !== -1,
      `csp=${csp}`
    );

    await context.close();
  }

  /* === 2. ACCEPT ALL ===
     Granting an embed category under an active CSP reloads, so this
     also proves the post-reload state is the one that matters. */
  {
    const { context, page } = await freshPage(browser);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click('[data-cc="allow"]')
    ]);

    check(
      "granting embeds drops the CSP on reload",
      await page.evaluate(
        () => !document.querySelector('meta[http-equiv="Content-Security-Policy"]')
      )
    );
    check(
      "embeds actually load once consented",
      requestLog.filter((u) => u.startsWith("/embeds/")).length === 2,
      `fetched: ${requestLog.filter((u) => u.startsWith("/embeds/")).join(", ")}`
    );

    eq("accept-all runs every tracker", await flags(page), {
      analyticsInline: true,
      analyticsExternal: true,
      marketingExternal: true,
      personalization: true
    });

    eq("accept-all stores all categories", (await storedConsent(context)).c, {
      analytics: 1,
      personalization: 1,
      marketing: 1
    });

    eq("accept-all updates Consent Mode", await consentSignal(page, "update"), {
      ad_storage: "granted",
      ad_user_data: "granted",
      ad_personalization: "granted",
      analytics_storage: "granted",
      functionality_storage: "granted",
      personalization_storage: "granted",
      security_storage: "granted"
    });

    eq("accept-all swaps banner for manager", await visible(page), {
      banner: false,
      prefs: false,
      manager: true
    });

    const embeds = await page.evaluate(() => ({
      manualSrc: document.getElementById("embed-manual").getAttribute("src"),
      autoSrc: document.getElementById("embed-auto").getAttribute("src"),
      placeholders: document.querySelectorAll("[data-cc-placeholder]").length
    }));
    check("accept-all restores both embeds", !!embeds.manualSrc && !!embeds.autoSrc, JSON.stringify(embeds));
    check("accept-all removes placeholders", embeds.placeholders === 0, `got ${embeds.placeholders}`);

    await context.close();
  }

  /* === 3. REJECT ALL === */
  {
    const { context, page } = await freshPage(browser);
    await page.click('[data-cc="deny"]');
    await page.waitForTimeout(300);

    eq("reject-all runs nothing", await flags(page), {
      analyticsInline: false,
      analyticsExternal: false,
      marketingExternal: false,
      personalization: false
    });
    eq("reject-all stores zeros", (await storedConsent(context)).c, {
      analytics: 0,
      personalization: 0,
      marketing: 0
    });
    eq("reject-all dismisses the banner", (await visible(page)).banner, false);
    await context.close();
  }

  /* === 4. GRANULAR: analytics only === */
  {
    const { context, page } = await freshPage(browser);
    await page.click('[data-cc="open-preferences"]');
    await page.waitForTimeout(100);

    const preTicked = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-cc-checkbox]")).filter((b) => b.checked).length
    );
    check("no checkbox is pre-ticked", preTicked === 0, `${preTicked} pre-ticked`);
    eq("preferences replaces the banner", await visible(page), {
      banner: false,
      prefs: true,
      manager: false
    });

    await page.evaluate(() => {
      const box = document.querySelector('[data-cc-checkbox="analytics"]');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click('[data-cc="submit"]');
    await page.waitForTimeout(300);

    eq("only analytics runs", await flags(page), {
      analyticsInline: true,
      analyticsExternal: true,
      marketingExternal: false,
      personalization: false
    });
    eq("granular choice is stored verbatim", (await storedConsent(context)).c, {
      analytics: 1,
      personalization: 0,
      marketing: 0
    });

    const signal = await consentSignal(page, "update");
    check(
      "granular Consent Mode keeps ads denied",
      signal.analytics_storage === "granted" && signal.ad_storage === "denied",
      JSON.stringify(signal)
    );
    check(
      "marketing embed stays blocked",
      await page.evaluate(() => !document.getElementById("embed-auto").getAttribute("src"))
    );
    await context.close();
  }

  /* === 5. RETURN VISIT === */
  {
    const { context, page } = await freshPage(
      browser,
      cookieFor({ analytics: 1, personalization: 0, marketing: 0 })
    );
    eq("stored consent suppresses the banner", await visible(page), {
      banner: false,
      prefs: false,
      manager: true
    });
    eq("stored consent replays on load", await flags(page), {
      analyticsInline: true,
      analyticsExternal: true,
      marketingExternal: false,
      personalization: false
    });
    const signal = await consentSignal(page, "update");
    check("stored consent updates Consent Mode on load", signal && signal.analytics_storage === "granted",
      JSON.stringify(signal));
    check(
      "analytics-only consent still blocks embeds",
      !requestLog.some((u) => u.startsWith("/embeds/")),
      `fetched: ${requestLog.filter((u) => u.startsWith("/embeds/")).join(", ")}`
    );
    await context.close();

    // A returning visitor who already allowed embeds must never see
    // the reload — the CSP is simply not emitted for them.
    const ok = await freshPage(
      browser,
      cookieFor({ analytics: 0, personalization: 0, marketing: 1 })
    );
    check(
      "returning consented visitor gets no CSP",
      await ok.page.evaluate(
        () => !document.querySelector('meta[http-equiv="Content-Security-Policy"]')
      )
    );
    check(
      "returning consented visitor loads embeds directly",
      requestLog.filter((u) => u.startsWith("/embeds/")).length === 2,
      `fetched: ${requestLog.filter((u) => u.startsWith("/embeds/")).join(", ")}`
    );
    await ok.context.close();
  }

  /* === 6. EXPIRY & VERSIONING === */
  {
    const stale = await freshPage(
      browser,
      cookieFor({ analytics: 1, personalization: 1, marketing: 1 }, { ageDays: 200 })
    );
    eq("consent older than 180 days is re-asked", (await visible(stale.page)).banner, true);
    eq("expired consent grants nothing", await flags(stale.page), {
      analyticsInline: false,
      analyticsExternal: false,
      marketingExternal: false,
      personalization: false
    });
    await stale.context.close();

    const old = await freshPage(
      browser,
      cookieFor({ analytics: 1, personalization: 1, marketing: 1 }, { version: 0 })
    );
    eq("consent from an older version is re-asked", (await visible(old.page)).banner, true);
    await old.context.close();
  }

  /* === 7. BANNER CLOSE BUTTON === */
  {
    const { context, page } = await freshPage(browser);
    await page.click('[data-cc="banner"] [data-cc="close"]');
    await page.waitForTimeout(200);
    eq("closing the banner never grants consent", (await storedConsent(context)).c, {
      analytics: 0,
      personalization: 0,
      marketing: 0
    });
    eq("closing the banner runs nothing", (await flags(page)).analyticsInline, false);
    await context.close();
  }

  /* === 8. MODAL A11Y === */
  {
    const { context, page } = await freshPage(browser);
    await page.click('[data-cc="open-preferences"]');
    await page.waitForTimeout(100);

    const dialog = await page.evaluate(() => {
      const el = document.querySelector('[data-cc="preferences"]');
      return {
        role: el.getAttribute("role"),
        modal: el.getAttribute("aria-modal"),
        ariaHidden: el.getAttribute("aria-hidden"),
        locked: document.documentElement.hasAttribute("data-cc-scroll-lock")
      };
    });
    eq("preferences is an accessible dialog", dialog, {
      role: "dialog",
      modal: "true",
      ariaHidden: "false",
      locked: true
    });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    eq("Escape closes and restores the banner", await visible(page), {
      banner: true,
      prefs: false,
      manager: false
    });
    check(
      "Escape releases the scroll lock",
      await page.evaluate(() => !document.documentElement.hasAttribute("data-cc-scroll-lock"))
    );
    check(
      "abandoning preferences stores nothing",
      (await storedConsent(context)) === null
    );
    await context.close();
  }

  /* === 9. PLACEHOLDER OPT-IN === */
  {
    const { context, page } = await freshPage(browser);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click("[data-cc-placeholder-button]")
    ]);

    eq("placeholder grants only its own category", (await storedConsent(context)).c, {
      analytics: 0,
      personalization: 0,
      marketing: 1
    });
    check(
      "placeholder loads the embed it fronted",
      await page.evaluate(() => !!document.getElementById("embed-manual").getAttribute("src"))
    );
    eq("placeholder does not run analytics", (await flags(page)).analyticsExternal, false);
    await context.close();
  }

  /* === 10. PUBLIC API === */
  {
    const { context, page } = await freshPage(browser);
    // Keep the assertions in one execution context; the reload path
    // is already covered by sections 2 and 9.
    await page.evaluate(() => {
      window.ConsentGate.config.reloadOnEmbedGrant = false;
    });
    await page.evaluate(() => window.ConsentGate.set({ marketing: true }));
    await page.waitForTimeout(200);
    eq("API set() writes a partial grant", (await storedConsent(context)).c, {
      analytics: 0,
      personalization: 0,
      marketing: 1
    });

    const evt = await page.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener("consentgate:change", (e) => resolve(e.detail), { once: true });
          window.ConsentGate.acceptAll();
        })
    );
    check("obel:consent event carries the decision", evt && evt.consent.analytics === 1, JSON.stringify(evt));
    check("obel:consent event records its source", evt && evt.source === "api", JSON.stringify(evt));

    await page.evaluate(() => window.ConsentGate.reset());
    await page.waitForTimeout(150);
    check("reset() clears the cookie", (await storedConsent(context)) === null);
    eq("reset() brings the banner back", (await visible(page)).banner, true);
    await context.close();
  }

  /* === 11. visibleClass — the "hide it in the Designer" setup ===
     Base selector is display:none so the component is out of the way
     in a visual editor. Only the combo class may make it render, so
     these assertions check actual layout, not just the attribute. */
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    requestLog = [];
    await page.goto(BASE() + "?visible=1", { waitUntil: "networkidle" });

    const rendered = () =>
      page.evaluate(() => {
        const at = (sel) => {
          const el = document.querySelector(sel);
          return {
            cls: el.classList.contains("is-visible"),
            painted: el.offsetParent !== null
          };
        };
        return {
          banner: at('[data-cc="banner"]'),
          prefs: at('[data-cc="preferences"]'),
          manager: at('[data-cc="manager"]')
        };
      });

    eq("visibleClass shows only the banner on a first visit", await rendered(), {
      banner: { cls: true, painted: true },
      prefs: { cls: false, painted: false },
      manager: { cls: false, painted: false }
    });

    await page.click('[data-cc="open-preferences"]');
    await page.waitForTimeout(150);
    eq("visibleClass swaps banner for the panel", await rendered(), {
      banner: { cls: false, painted: false },
      prefs: { cls: true, painted: true },
      manager: { cls: false, painted: false }
    });

    await page.click('[data-cc="submit"]');
    await page.waitForTimeout(300);
    eq("visibleClass leaves only the manager after a decision", await rendered(), {
      banner: { cls: false, painted: false },
      prefs: { cls: false, painted: false },
      manager: { cls: true, painted: true }
    });

    check(
      "visibleClass still stores the decision",
      (await storedConsent(context)) !== null
    );
    await context.close();
  }

  await browser.close();
}

/* ---------- go ---------- */
server.listen(0, "127.0.0.1", async () => {
  try {
    await run();
  } catch (err) {
    failures.push({ name: "suite crashed", detail: err.stack });
  }
  server.close();

  const total = pass + failures.length;
  if (failures.length) {
    console.log(`\nFAIL  ${pass}/${total}\n`);
    failures.forEach((f) => console.log(`  ✗ ${f.name}\n      ${f.detail || ""}`));
    process.exit(1);
  }
  console.log(`\nPASS  ${pass}/${total} assertions\n`);
});
