# Consent Gate

A first-party cookie consent gate for Webflow and other static sites.
Blocks scripts and third-party embeds **before** consent, speaks Google
Consent Mode v2, and costs nothing.

~11 KB minified. No dependencies. No build step on the consuming site.
No subscription.

```html
<script src="https://cdn.jsdelivr.net/gh/vitaminswell/consent-gate@v1.0.1/dist/consent-gate.min.js"
        data-cg-cookie="acme-consent"></script>
```

---

## Why this exists

Most cookie banners are a script that toggles some attributes. What the paid
tools actually sell is consent *logging* you can show a regulator, automatic
cookie scanning, IAB TCF certification, and geo-targeting. If you don't need
those — and most brochure sites don't — you're paying a subscription for the
attribute toggling.

This is the attribute toggling, done properly.

## Install

**1. Load it in the `<head>`, above every tracker.**

```html
<script src="https://cdn.jsdelivr.net/gh/vitaminswell/consent-gate@v1.0.1/dist/consent-gate.min.js"
        data-cg-cookie="acme-consent"></script>
```

Not `async`. Not `defer`. This is not a style preference:

- The gate must finish before the parser reaches your first embed.
- Its CSP fallback can only be written by a parser-blocking script.

A consent banner loaded in the footer is decorative. By the time it runs, the
cookies it claims to gate are already set.

**2. Add the markup.** Any banner design works — the script only looks for
`data-cc` attributes, never classes. Minimum viable:

```html
<div data-cc="banner" hidden>
  <p>We use cookies. <a href="/privacy">Privacy Policy</a></p>
  <button data-cc="allow">Accept</button>
  <button data-cc="deny">Decline</button>
  <button data-cc="open-preferences">Preferences</button>
</div>

<div data-cc="preferences" hidden>
  <label><input type="checkbox" data-cc-checkbox="analytics"> Analytics</label>
  <label><input type="checkbox" data-cc-checkbox="marketing"> Marketing</label>
  <button data-cc="submit">Save preferences</button>
  <button data-cc="deny">Reject all</button>
  <button data-cc="close">Close</button>
</div>

<div data-cc="manager" hidden>
  <button data-cc="open-preferences">Cookie preferences</button>
</div>
```

**3. Optionally** add `dist/consent-gate.css` for the blocked-embed
placeholder. Everything else is styled by you.

### Markup reference

| Attribute | On | Does |
|---|---|---|
| `data-cc="banner"` | container | The consent banner |
| `data-cc="preferences"` | container | The preferences dialog |
| `data-cc="manager"` | container | Persistent re-open button, shown after a decision |
| `data-cc="allow"` | button | Accept all |
| `data-cc="deny"` | button | Reject all |
| `data-cc="submit"` | button | Save whatever the checkboxes say |
| `data-cc="open-preferences"` | button | Open the dialog |
| `data-cc="close"` | button | Close dialog, or dismiss banner (see `closeMeans`) |
| `data-cc-checkbox="<category>"` | `input[type=checkbox]` | Toggle for one category |
| `data-cc-toggle` | wrapper *(optional)* | Gets `data-cc-checked="true\|false"` mirrored onto it, for styling custom toggles |

## Tagging trackers

**Scripts** ship inert and are revived on consent:

```html
<script type="text/plain" data-cc-category="analytics"
        data-cc-src="https://example.com/analytics.js"></script>

<script type="text/plain" data-cc-category="marketing">
  fbq('init', '...');
</script>
```

`type="text/plain"` is what stops the parser executing them.

**Google Tag Manager needs no tagging.** Load it normally — Consent Mode
defaults are denied before it boots and it censors itself. Tag only pixels you
fire outside GTM.

**Embeds** — move `src` to `data-cc-src`:

```html
<iframe data-cc-src="https://player.vimeo.com/video/123"
        data-cc-category="marketing"></iframe>
```

Untagged YouTube / Vimeo / Maps iframes are caught automatically, but tag them
properly where you can — see below for why.

## How the blocking works

Three layers, because the obvious one is not sufficient.

**1. Consent Mode v2 defaults.** Pushed to `dataLayer` before GTM exists, all
denied. GTM reads them on boot and suppresses its own cookies.

**2. Inert scripts.** `type="text/plain"` elements are swapped for real
`<script>` elements when their category is granted. Airtight — the parser never
runs them.

**3. Embeds.** A MutationObserver strips `src` from third-party iframes, but
**this races and loses**: the browser dispatches the request before the callback
runs. That's measured, not assumed — `test/verify.js` asserts zero network
requests, and the observer alone does not satisfy it.

So while the embed categories are denied, the script also writes a parser-time
`Content-Security-Policy: frame-src` meta tag. The network stack enforces it and
nothing can race it.

The CSP costs one thing: a meta CSP cannot be relaxed after parsing, so granting
an embed category **on a page that has embeds** reloads once. Returning visitors
never see it — the CSP simply isn't emitted for them. Set
`hardBlockEmbeds: false` to trade the guarantee for the reload.

reCAPTCHA frames stay allowlisted throughout, so Webflow forms keep working.

## Configuration

Simple things go on the script tag:

```html
<script src=".../consent-gate.min.js"
        data-cg-cookie="acme-consent"
        data-cg-categories="analytics,marketing"
        data-cg-lifetime="180"
        data-cg-version="1"
        data-cg-domain=".example.com"
        data-cg-close="deny"></script>
```

Everything else goes in a global declared **before** the script:

```html
<script>
  window.ConsentGateConfig = {
    categories: {
      analytics: ["analytics_storage"],
      marketing: ["ad_storage", "ad_user_data", "ad_personalization"]
    },
    embedBlocklist: [["fast.wistia.net", "marketing"]],
    text: {
      placeholder: "Dette indhold sætter cookies fra tredjepart.",
      placeholderButton: "Tillad og indlæs"
    }
  };
</script>
```

| Option | Default | Notes |
|---|---|---|
| `cookieName` | `"consent"` | |
| `lifetimeDays` | `180` | Stale consent is not consent. 12 months is the outer limit. |
| `version` | `1` | Bump to re-ask everyone. |
| `domain` | `null` | `".example.com"` to share across subdomains. |
| `closeMeans` | `"deny"` | Or `"none"` to keep asking. Never make it accept. |
| `visibleClass` | `null` | Combo class toggled when a container is shown. See below. |
| `categories` | analytics, personalization, marketing | Category → the Consent Mode signals it governs. Rename freely; the UI follows. |
| `consentMode` | `true` | Turn off only if the site has no Google tags at all. |
| `autoBlockEmbeds` | `true` | Catch untagged third-party iframes. |
| `hardBlockEmbeds` | `true` | The CSP layer. |
| `reloadOnEmbedGrant` | `true` | |
| `alwaysAllowedFrames` | reCAPTCHA hosts | Never CSP-blocked. |
| `embedBlocklist` | YouTube, Vimeo, Maps, … | `[hostFragment, category]` pairs. |
| `text` | English | The whole translation surface. |

`essential` is implicit, always granted, and needs no checkbox.

### Hiding the component in a visual editor

By default the script shows an element by removing `[hidden]` and letting your
own class supply the display value — so it never has to guess flex vs grid vs
block. The trade-off: **you cannot put `display: none` on that base class.** It
would win, and the banner would silently never appear, in the editor *and*
live. There is no error; it just doesn't show.

If you want the component out of the way while designing, invert it with
`visibleClass`:

```html
<script src=".../consent-gate.min.js" data-cg-visible-class="is-visible"></script>
```

```css
.cookie_banner_wrap            { display: none }   /* base — invisible in the editor */
.cookie_banner_wrap.is-visible { display: flex }   /* combo — the real layout */
```

The combo class has higher specificity, so it wins whenever the script applies
it. Do the same on the preferences panel and the manager button. In Webflow:
set `display: none` on the base class, add an `is-visible` combo class, and set
the real display there.

## API

```js
ConsentGate.get()              // {analytics:1,…} or null if undecided
ConsentGate.has('analytics')   // boolean
ConsentGate.decidedAt()        // unix seconds
ConsentGate.acceptAll()
ConsentGate.rejectAll()
ConsentGate.set({ analytics: true })
ConsentGate.open()             // preferences dialog
ConsentGate.reset()            // clear and re-ask — useful when testing

document.addEventListener('consentgate:change', e => {
  e.detail // { consent, source, decidedAt, reloading }
});
```

Put `data-cc="open-preferences"` in the footer next to the privacy policy link.
Withdrawing consent has to be as easy as giving it.

## Stored consent

One first-party cookie:

```json
{"v":1,"t":1755518400,"c":{"analytics":1,"personalization":0,"marketing":0}}
```

`t` is the decision timestamp — the audit trail if anyone asks *when* consent
was given. Nothing is written before a choice is made, and no checkbox is ever
pre-ticked.

## Consent receipts

There's no built-in logging backend, but `consentgate:change` carries
everything a receipt needs:

```js
document.addEventListener('consentgate:change', e => {
  if (e.detail.reloading) return;
  navigator.sendBeacon('/api/consent', JSON.stringify({
    consent: e.detail.consent,
    at: e.detail.decidedAt,
    policyVersion: ConsentGate.config.version,
    source: e.detail.source
  }));
});
```

Point that at a Make.com webhook, a Supabase table, or a serverless function.
Honouring consent is what this library does; *proving* it needs a server, and
that's deliberately your choice of one.

## What this deliberately doesn't do

- **Server-side consent logging.** See above.
- **Automatic cookie scanning.** Categories are maintained by hand.
- **IAB TCF / certified CMP status.** Only relevant for programmatic ad buying.
- **Geo-targeting.** Everyone gets opt-in, everywhere. Simpler, and stricter
  than required outside the EU.

If you need the first three, buy a CMP — that's what you'd be paying for.

## Compliance notes

This is a tool, not legal advice. Two things it can't do for you:

- **Make your buttons equally prominent.** If Accept is a filled button and
  Reject is a text link, that's a dark pattern regardless of what the script
  does. Regulators are actively enforcing on this.
- **Write your cookie policy.**

## Development

```bash
npm install
npx playwright install chromium
npm test        # runs the suite against src, then against the built bundle
```

52 assertions covering pre-consent silence, Consent Mode signals, accept /
reject / granular paths, cookie expiry and versioning, dialog accessibility, and
the CSP embed block. Both the source and the shipped minified bundle must pass —
they've caught two real ordering bugs that only appeared in one of the two.

## Releasing

jsDelivr serves whatever is committed at a tag, so `dist/` is committed.

```bash
npm run build
git commit -am "v1.0.1"
git tag v1.0.1 && git push --tags
```

Then reference `@v1.0.1` in the script URL. Pin the tag — never point production
at `@main`.

## License

MIT
