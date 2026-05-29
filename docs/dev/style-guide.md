# Style Guide

Conventions for the Librito web app frontend. Companion to `CLAUDE.md`; this doc
focuses on visual + typographic decisions, not architecture.

## 1. Font stack

| Face           | Use                                            | Source                                      |
| -------------- | ---------------------------------------------- | ------------------------------------------- |
| Inter (static) | Body, UI, controls at sizes ≤ 18 px            | Self-hosted Latin subset 400 / 600 / 700    |
| InterVariable  | Bare `<h1>` / `<h2>` and the book-detail title | Self-hosted Latin subset (`inter-ui` 4.1)   |
| Literata       | Highlight blockquote body                      | Self-hosted Latin subset (regular + italic) |
| JetBrains Mono | `.page-header h2`, code placeholders           | Self-hosted 500                             |

Critical weights preload from `src/lib/fonts.ts` via `<link rel="preload">`
with matching `@font-face { font-display: optional }` declarations in
`src/app.css`. InterVariable and the static Inter cuts share metrics —
the fallback cascade `"InterVariable", "Inter", …` produces no layout
shift when the variable file misses the optional-load window.

**Why two Inter forms.** Static Inter (opsz=14 baked in) is ~23 KB per
weight and serves the body cheaply. InterVariable (~97 KB, all weights
100-900 + opsz axis 14-32) is opted into for headings so we can pin
opsz explicitly per use case rather than letting the static-Display
cut (`opsz=32`) impose its tight Display kerning at 24–28 px sizes.

## 2. Typography

### 2.1 Type scale

Six size tokens, mapped to `font-size` declarations across the app.

| Token | rem   | px  | Use                                                                |
| ----- | ----- | --- | ------------------------------------------------------------------ |
| xs    | 0.75  | 12  | Timestamps, micro-labels                                           |
| sm    | 0.875 | 14  | Body small, captions, button labels                                |
| base  | 1     | 16  | Default body, card author / meta, catalog description              |
| md    | 1.125 | 18  | Card titles (`.book-title`), primary nav items, book detail author |
| lg    | 1.25  | 20  | `.menu-primary-item` at ≥ 600 px (desktop bump)                    |
| xl    | 1.5   | 24  | `.page-header h2` (JetBrains Mono); `.book-detail-title`           |

Bare `<h1>` at the browser default 32 px is covered by the `2xl`
tracking token (no `2xl` _size_ token because no class explicitly uses
1.75 rem / 28 px).

### 2.2 Tracking (`letter-spacing`)

Inter ships with zero tracking baked in. Negative `letter-spacing` per
size, derived from Rasmus Andersson's dynmetrics formula, makes Inter
read with the visual rhythm of system UI faces:

```
tracking = a + b × e^(c × z)
  a = -0.0223
  b = +0.185
  c = -0.1745
  z = font-size in px
```

Source: <https://rsms.me/inter/dynmetrics/>.

Values rounded to 3 decimal places, declared as CSS custom properties on
`:root` in `src/app.css`. Apply the matching token to any Inter-family
class that sets `font-size`:

| Token             | px  | Computed (em) | Declared   |
| ----------------- | --- | ------------- | ---------- |
| `--tracking-xs`   | 12  | +0.0005       | `0em`      |
| `--tracking-sm`   | 14  | -0.0062       | `-0.006em` |
| `--tracking-base` | 16  | -0.0110       | `-0.011em` |
| `--tracking-md`   | 18  | -0.0143       | `-0.014em` |
| `--tracking-lg`   | 20  | -0.0167       | `-0.017em` |
| `--tracking-xl`   | 24  | -0.0195       | `-0.019em` |
| `--tracking-2xl`  | 32  | -0.0216       | `-0.022em` |

**Inter has no weight offset.** Lab data
(<https://rsms.me/inter/lab/>) confirms Inter @700 at 18/20/24 px =
-1.4 % / -1.7 % / -1.9 %, matching the formula. Apply the same token
regardless of `font-weight`.

**Zero crossing.** The curve crosses zero near 12 px. Sizes below 12 px
**loosen** (positive tracking); sizes above **tighten** (negative).
`.lang-btn span:last-child` is the only sub-12 px element today
(12 px @600 all-caps locale code); its explicit
`letter-spacing: 0.5px` overrides the inherited base tracking for
wide-caps optical loosening.

### 2.3 Application rule

`body { letter-spacing: var(--tracking-base); }` propagates the 16 px
tracking through inheritance. Every class that sets an explicit
`font-size` should also set a matching `letter-spacing` token so the
two stay aligned if a future size bump lands.

Non-Inter elements must reset to `letter-spacing: normal`: Literata
blockquote, JetBrains Mono headings (`.page-header h2`), the JetBrains
book-cover placeholder. The dynmetrics curve is SF-derived and wrong
for serif and monospace.

### 2.4 Headings ≥ 20 px: pinned-opsz recipe

Bare `<h1>` and `<h2>` elements in user routes (`/`, `/app/transfer`,
`/app/devices`, `/auth/{login,signup,verify-email}`, `.book-detail-title`)
share a single recipe declared globally in `app.css`:

```css
h1,
h2 {
  font-family: "InterVariable", "Inter", …, sans-serif;
  font-variation-settings: "opsz" 14;
  letter-spacing: normal;
}
```

`opsz=14` gives the InterVariable file its Text optical character —
looser apertures, wider intrinsic kerning, no compression on the `Co`
pair. The dynmetrics tracking tokens are NOT applied to these headings
because the opsz=14 cut is already loose; stacking the formula on top
over-tightens. The earlier attempt to use the static Inter Display cut
(`opsz=32`) at 24 px produced visibly cramped kerning — the canonical
regression case.

**More-specific overrides remain:**

- `header h1` (18 px @700 in the global header) keeps
  `letter-spacing: var(--tracking-md)` — body-size, not a hero, so the
  formula applies normally.
- `.page-header h2` switches `font-family` to JetBrains Mono and keeps
  `letter-spacing: normal` via its existing reset.

When adding a new `<h1>` / `<h2>` element: just write the markup. The
global rule covers it. Override only `font-size`, `font-weight`,
`line-height`, and `color` as needed.

### 2.5 OpenType features

Currently unconfigured. Tracked follow-ons (separate issues if
desired):

- `cv11` for ≤ 13 px legibility (alternate single-storey a/g).
- `ss03` for friendly `g`.
- `tnum` / `zero` for numeric tables (`.book-meta`, transfer page).

## 3. Layout & positioning

**Layout/positioning properties never live on a bare element (type) selector
— only on classes or component-scoped styles.** Typography on tags stays
allowed (see §2 and #421).

The properties: `position`, `z-index`, `inset` (and `top`/`right`/`bottom`/
`left` + logical longhands), and `transform` (and `translate`/`rotate`/
`scale`). On a reused semantic element (`<header>`, `<blockquote>`, `<main>`,
`<nav>`, …) these leak **structurally** — a wrong stacking context or a
surprise sticky element — not cosmetically. The canonical regression: a global
`header { position: sticky; z-index: 60 }` meant for the site header landed on
the book-detail page's `<header class="book-header">`, painting book content
over the open menu overlay (#472).

**Where positioning belongs instead:**

- A **class** (`.menu-overlay { position: fixed }`) — anchored, intentional.
- A **component-scoped `<style>`** (Svelte hashes the selector, e.g.
  `blockquote { position: relative }` inside `HighlightBlock.svelte`).
- A class anywhere in the selector counts as an anchor, so
  `.menu-icon span { position: absolute }` is fine.

**Enforced** by `stylelint/no-positioning-on-bare-type.js` (run via
`npm run lint:css`, gated in CI by `.github/workflows/lint-css.yml`). The rule
is property-gated and selector-gated: it fires only on a positioning property
on a type selector with no class/id anchor. In Svelte `<style>`, bare selectors
are auto-scoped, so only `:global(type)` is flagged.

## 4. Color

(TBD — extract from existing `app.css` palette when next touched.)
