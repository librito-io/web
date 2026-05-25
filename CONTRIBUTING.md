# Contributing to Librito Web

Thanks for contributing. The full project convention lives in [`CLAUDE.md`](CLAUDE.md) (architecture, tech stack, scaling targets) and [`docs/dev/`](docs/dev/) (commits, issues, self-hosting, realtime signing key).

## Setup

```sh
npm install          # wires the commit-msg hook automatically via husky
supabase start       # local Postgres on :54322 + auth + storage
npm run dev          # SvelteKit dev server
```

`npm install` runs the `prepare` script which sets up [husky](https://typicode.github.io/husky/) so the `commit-msg` hook fires on every commit. No manual hook setup needed, including in fresh `git worktree` checkouts.

## Commit messages

Commit messages are gated locally by `.husky/commit-msg` and on every PR by `.github/workflows/commitlint.yml` (both run [commitlint](https://commitlint.js.org/) against [`commitlint.config.mjs`](commitlint.config.mjs)). Convention: **Conventional Commits** prefix from `feat` `fix` `bug` `chore` `docs` `test` `perf` `refactor`, lowercase subject, no trailing period, subject ≤100 chars. Full rules + rationale (including soft targets of 50 / 72 chars) in [`docs/dev/commits.md`](docs/dev/commits.md).

PR titles are validated separately by `.github/workflows/lint-pr-title.yml` using the same Conventional Commits format. Because the repo is squash-merged with `COMMIT_MESSAGES`, the per-commit messages on your branch become the durable archeology in `git log` on `main` — write them as if no PR existed.

## Tests

- `npm test` — fast unit suite (mocked Supabase, no infra needed)
- `npm run check` — TypeScript + Svelte type check
- `npm run test:integration` — behavior-level migration suite (requires `supabase start`)
- `npm run test:e2e` — Playwright suite (requires `supabase start` + `npx playwright install chromium`)

## Issues

All work tracked in the Librito GitHub Project: https://github.com/orgs/librito-io/projects/1. Full filing protocol in [`docs/dev/issue-tracking.md`](docs/dev/issue-tracking.md).
