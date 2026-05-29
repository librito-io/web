# Motion language

> **Status: work in progress.** Not a strict guide yet — the tokens, springs,
> and principles below are a starting point we'll keep tweaking as we build more
> animated components, until a consistent framework settles.

The shared vocabulary and rules for animation across the Librito web app. The
goal is a coherent feel — a sync pulse, a pill slide, and a transfer-success
check should read like one hand drew them — without re-deriving easing and
timing per component.

The **design language is the tokens and principles, not the engine.** The slick
"Apple-like" feel comes ~90% from curves, timing, and restraint; the engine just
draws the frames.

## Engine policy

**Svelte-default + GSAP escape hatch.**

| Need                                                                     | Tool                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Enter/exit, fades, slides, list reflow                                   | Svelte `transition:` / `animate:flip` / `crossfade`          |
| Value-driven / interruptible motion (sliding indicators, toggles, drags) | Svelte `Spring` / `Tween` (`svelte/motion`)                  |
| Theme + cross-route transitions                                          | View Transitions API via SvelteKit `onNavigate`              |
| Timeline choreography, scroll-driven, reparent-FLIP, SVG morph           | **GSAP** — lazy-loaded, client-only, scoped to the component |

Svelte built-ins are the house style: 0 kb, SSR-safe, idiomatic, and best-in-class
for presence (enter/exit on unmount) and reactive value→motion. Reach for GSAP
**only** where built-ins genuinely fall short (Timeline, ScrollTrigger, Flip,
MorphSVG). Don't pay its ~23 kb + imperative cost on the 80% that `transition:fade`
does for free. **Skip Motion / Framer Motion** — in a non-React app it overlaps the
built-ins and its headline layout-animation magic is React-only.

Whichever engine draws a frame, durations and curves come from the tokens below.

## Tokens

Defined twice, kept in sync by hand:

- CSS custom props — `:root` in [`src/app.css`](../../src/app.css) (`--dur-*`, `--ease-*`, `--press-scale`).
- JS mirrors — [`src/lib/motion/index.ts`](../../src/lib/motion/index.ts) (`DURATION`, `EASE`, `PRESS_SCALE`, `SPRING`, `prefersReducedMotion()`).

**Durations** — `--dur-1` 120ms (taps) · `--dur-fast` 150ms (press) · `--dur-2`
180ms (hover) · `--dur-3` 240ms (default UI) · `--dur-4` 360ms (entrances) ·
`--dur-5` 600ms (page/theme). Smaller distance ⇒ shorter; exits shorter than enters.

**Easings** — `--ease-out` (enters/responses, the decelerate "settle") ·
`--ease-in-out` (on-screen A→B moves) · `--ease-in` (**exits only**) ·
`--ease-hover` (hovers).

**Springs** — `SPRING.snappy` (indicators/toggles, near-zero overshoot) ·
`SPRING.smooth` (weightier surfaces) · `SPRING.gentle` (ambient). Restrained,
low-bounce — settle, don't wobble.

## Principles

1. **Animate `transform` + `opacity` only** in hot paths — GPU-composited, no
   layout thrash. Use `translate`/`scale`, never `width`/`top`/`left` to move things.
2. **Match the curve to the situation.** Entering or responding to input →
   `--ease-out` (fast start, settle). On-screen A→B move → `--ease-in-out`. Leaving
   → `--ease-in`. **Never** put `ease-in` on a response — it lags the input and
   feels sluggish. Avoid `linear` (robotic) and default symmetric `ease` on UI.
3. **Enter ≠ exit.** Entrances decelerate; exits accelerate and are shorter.
4. **Press feedback.** Interactive elements scale to `--press-scale` (0.97) on
   `:active` for instant, tactile acknowledgement
   (`transition: transform var(--dur-fast) var(--ease-out)`).
5. **Interruptible.** Anything the user can re-trigger fast (toggles, drags, the
   section nav) uses a spring so it retargets mid-flight instead of queueing/snapping.
6. **Origin-aware.** Things grow/slide from where they came (transform-origin,
   shared element).
7. **Respect `prefers-reduced-motion`.** Drop movement/scale, keep opacity. Gate
   JS motion with `prefersReducedMotion()`; gate CSS with the media query.
8. **Restraint.** If a user sees it 100×/day, don't animate it. Motion earns its
   place by clarifying a state change, not decorating one.

### Techniques (use selectively)

- **Fake motion blur** — a brief `filter: blur(2px)` during a state swap blends the
  two states so the eye reads continuity. Slick but not free (blur is costlier than
  transform/opacity): small elements, short durations, not everywhere.

## Consumers

The section-nav sliding indicator ([`SectionNav.svelte`](../../src/lib/components/SectionNav.svelte))
is the first consumer. Planned: book-transfer status sequence (GSAP Timeline
candidate), login/signup entrances, feed sync indicators, dark↔light theme
(View Transitions; needs a light theme first). Add a token only when a real need
can't be expressed with the existing set — resist proliferation.
