// Commit message rules — enforced locally via .husky/commit-msg, in CI via
// .github/workflows/commitlint.yml. Full convention + rationale in
// docs/dev/commits.md. PR titles validated separately by
// .github/workflows/lint-pr-title.yml (amannn/action-semantic-pull-request).

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Adds `bug` to the conventional-commits default 8 types — Librito
    // convention for "user-facing defect fix" distinct from `fix` for
    // internal-only regressions.
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "bug", "chore", "docs", "test", "perf", "refactor"],
    ],
    // 100 catches genuine runaway subjects without rejecting the
    // substantive conjunctive subjects ("X + Y", "replace X with Y")
    // that empirically make up ~13% of this repo's history above 72.
    // Soft target of 50 (Tim Pope) / 72 (kernel docs) lives in
    // docs/dev/commits.md as guidance, not as a gate.
    "header-max-length": [2, "always", 100],
    // Disable per-line body/footer wrap. Modern consumers (GitHub UI,
    // gh CLI, mobile, IDE diff viewers) soft-wrap; hard-wrap at any
    // fixed width bakes the author's terminal into the commit data and
    // renders worse on narrower screens. Librito has no mailing-list
    // (`git format-patch`) workflow that needs fixed-width.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
