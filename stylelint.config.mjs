import noPositioningOnBareType from "./stylelint/no-positioning-on-bare-type.js";

/** @type {import("stylelint").Config} */
export default {
  plugins: [noPositioningOnBareType],
  // Plain CSS (src/app.css): every selector is globally reachable.
  rules: {
    "librito/no-positioning-on-bare-type": [true, { mode: "global" }],
  },
  overrides: [
    {
      // Svelte <style> blocks: selectors are auto-scoped by Svelte's hash,
      // so only :global(type) reaches out. postcss-html extracts the CSS.
      files: ["**/*.svelte"],
      customSyntax: "postcss-html",
      rules: {
        "librito/no-positioning-on-bare-type": [true, { mode: "scoped" }],
      },
    },
  ],
};
