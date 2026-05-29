/**
 * Motion language — JS side.
 *
 * The coherence layer for every animation in the app. CSS-driven motion
 * reads the `--dur-*` / `--ease-*` custom props in `src/app.css`; JS-driven
 * motion (Svelte `Spring`/`Tween`, and GSAP once it enters as the escape
 * hatch) reads the mirrors here. Keep the two in sync by hand — same
 * numbers, two consumers, one feel.
 *
 * Principles + rationale (when to animate, ease-out vs ease-in, the press
 * + blur techniques): docs/dev/motion-language.md.
 *
 * Default engine is Svelte built-ins; GSAP is reserved for timeline
 * choreography / scroll-driven motion only. Whichever draws the frames,
 * the durations and curves come from this vocabulary.
 */

/** Durations in ms. Mirror of `--dur-*`. Smaller distance ⇒ shorter;
 *  exits shorter than enters. */
export const DURATION = {
  d1: 120,
  fast: 150,
  d2: 180,
  d3: 240,
  d4: 360,
  d5: 600,
} as const;

/** Easing cubic-beziers. Mirror of `--ease-*`. Response & entrance
 *  decelerate (out); on-screen moves use in-out; only exits use in. */
export const EASE = {
  out: "cubic-bezier(0.16, 1, 0.3, 1)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
  hover: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

/** Press-feedback scale. Mirror of `--press-scale`. */
export const PRESS_SCALE = 0.97;

/**
 * Named Svelte `Spring` presets — `{ stiffness, damping }` on the 0–1
 * scale Svelte uses (higher stiffness = faster, higher damping = less
 * overshoot). Tuned for the restrained, low-bounce "settle" feel rather
 * than playful springiness.
 *
 *   import { Spring } from "svelte/motion";
 *   const pos = new Spring({ x: 0, w: 0 }, SPRING.snappy);
 */
export const SPRING = {
  /** Quick, near-zero overshoot — UI that tracks a discrete change
   *  (the section-nav indicator, toggles). */
  snappy: { stiffness: 0.2, damping: 0.85 },
  /** A touch softer; larger surfaces that should feel weightier. */
  smooth: { stiffness: 0.12, damping: 0.8 },
  /** Gentle, slow settle — ambient / decorative motion. */
  gentle: { stiffness: 0.08, damping: 0.75 },
} as const;

/**
 * Whether the user has asked the OS to minimise motion. Animations
 * should honour this by snapping instead of moving (keep opacity, drop
 * translation/scale). SSR-safe: returns `false` when `matchMedia` is
 * unavailable so the server render is the full-motion default and
 * hydration corrects it on the client.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
