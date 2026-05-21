# Issue tracking

All work — bugs, features, chores, docs — is tracked in GitHub Issues under the `librito-io` org's "Librito" Project (`https://github.com/orgs/librito-io/projects/1`). The Project spans both `librito-io/web` and `librito-io/reader`. New issues from either repo auto-add to the Backlog column.

## When to file

- Incidental finds during a primary task — file immediately. Do not stash in markdown trackers.
- Bug encountered, not fixing now — file.
- Feature idea / tech-debt spotted — file.
- Already covered by an open issue — comment, don't dupe.
- Question with no clear answer — GitHub Discussions, not Issues.

## How to file

CLI (Claude default):

```bash
# Step 1: create issue (gh ≤ 2.92 has no --type flag)
ISSUE_URL=$(gh issue create --repo librito-io/web \
  --title "<imperative summary>" \
  --label "area:<x>" \
  --body "...")

# Step 2: set Issue Type via REST API
NUM=${ISSUE_URL##*/}
gh api repos/librito-io/web/issues/$NUM -F type=Chore --silent
```

`--type` was not yet released in `gh` CLI as of v2.92.0 (2026-04-28); upstream work is tracked in [cli/cli#13057](https://github.com/cli/cli/pull/13057). Setting Issue Type post-create via `gh api ... -F type=<Bug|Feature|Chore|Docs>` is the only working path. Drop the post-create call once `gh issue create --type` lands and `gh ≥ <that-version>` is the local minimum.

Web UI: pick a template (Web bug / Feature request / Chore). Blank issues are disabled.

## Title format

Imperative summary. No prefix.

Type is carried in the GitHub-native **Issue Type** field (`Bug`/`Feature`/`Chore`/`Docs`); area is carried in `area:*` labels. Embedding either in the title would duplicate queryable metadata in unqueryable form.

Examples:

- `NYT warmup leaks API key in logs` (Type: Bug, label: `area:catalog`)
- `Add highlight export to markdown` (Type: Feature, label: `area:feed`)
- `Add database.ts to .prettierignore` (Type: Chore, label: `area:ci`)

Conventional Commits prefixes (`feat`/`fix`/`chore`/`docs`/`test`/`perf`/`refactor`) remain canonical for **commits and PR titles** — see [`docs/dev/commits.md`](commits.md). They are intentionally not used on issue titles, matching established practice in major OSS repos (issue = noun/classification via label/Type; commit = verb/action via prefix).

## Body sections (required for CLI-filed issues)

Use these exact `##` headings, in this order:

```markdown
## Problem

## Solution

## Discovery

## Acceptance
```

Content per section:

1. **Problem** — what's wrong / what's needed
2. **Solution** — concrete approach (mark optional / `_unknown_` for bugs without a known fix)
3. **Discovery** — which task/PR surfaced this (link the PR)
4. **Acceptance** — what does "done" look like

Half-formed issues become ghosts. No exceptions.

State (`blocked`, etc.) goes in **labels**, not body sections — do not add a 5th section for status flags.

**Templates intentionally diverge** — bug/feature/chore form templates serve external contributors and have richer per-type fields (Steps to reproduce, Browser/OS, Why, Scope, etc.). The 4-section canonical above is for CLI-filed issues by maintainers / Claude — internal scaffold for quick filing with full context.

## Issue type (native, org-level)

Set the **Issue Type** on every issue — `Bug`, `Feature`, `Chore`, or `Docs`. Issue Types are GitHub-native, org-level (cross-repo), filterable via `type:Bug` syntax. Templates set the type automatically; CLI flow uses the two-step create-then-`gh api -F type=...` pattern (see "How to file" above) until `gh issue create --type` ships upstream.

Type labels (`bug`, `feat`, `chore`, `docs`) are superseded by Issue Types. They do not exist in this repo. Do not create them.

## Labels (this repo)

**Area** (pick one or more): `area:sync` `area:auth` `area:catalog` `area:transfer` `area:realtime` `area:feed` `area:ui` `area:i18n` `area:docs` `area:db` `area:ci` `area:infra`

**Status** (auto-applied / cross-cutting): `needs-triage`, `blocked`, `deferred`

- `needs-triage` — auto-applied by `.github/workflows/triage.yml` when type or area missing. Removed manually after triage.
- `blocked` — wants to proceed, can't. Waiting on an external dependency (upstream PR, hardware change, design decision someone else owns). Comment on the issue naming the blocker. Removed when the blocker resolves.
- `deferred` — could proceed, choosing not to right now. No external dependency. **Issue body must document the trigger that should revive it** (e.g. "re-open when first outside contributor PR lands" or "re-evaluate at 100 active users"). Without a trigger, prefer closing — open-deferred-with-no-trigger is just clutter.

**Cross-repo alignment**: `area:sync`, `area:realtime`, `area:transfer` exist in both web and reader with parallel scope — apply the same label in both repos for cross-stack work. Pairing splits: `area:auth` (web bundles device auth + browser sessions + pairing) / `area:pairing` (reader).

## Triage

New issues are added to Backlog and auto-labeled `needs-triage` **only if** the workflow can't see both an Issue Type and at least one `area:*` label on the opened issue (`.github/workflows/triage.yml`). CLI-filed issues that follow "How to file" already set both, so they bypass `needs-triage` and land in Backlog clean. Web-template / form-filed issues, or CLI issues missing either dimension, get stamped.

Implication: absence of `needs-triage` means the issue was filed with type + area already set — it does not mean a human triaged it. Workstream assignment and "does this fit a phase?" judgement still happen at session start or when Backlog accumulates. ~30 seconds per issue when triage is needed: confirm Issue Type, set area label(s), set Workstream if it fits a phase, remove `needs-triage`.

## Working an issue

Branch references the issue (`feat/highlights-export-md` for #42). PR body includes `Closes #42`. Project workflows handle Status transitions automatically (PR opened → In Progress, merged → Done).

## Closing without merging

Always close with a comment explaining why. No `wontfix` / `duplicate` / `invalid` labels — close-comment is the durable archeology.

## Cross-repo issues

Two issues, one per repo, same Workstream value, cross-link in bodies. Don't combine.

## Audit doc hybrid

Audit docs (`docs/audits-wip/` → `docs/audits/`) keep their place for structured campaigns but their role narrows: planner, not parallel backlog.

- Audit doc enumerates findings + decisions (fix / skip / defer)
- Each "fix" finding → file a GitHub issue, link from doc by issue number
- Skip findings stay in doc only — no issue, skip rationale = record
- Optional: set the same Workstream value on every issue spawned from one audit, for campaign-level Project view

## Naming conventions for workstreams / spec files / audit docs

Descriptive titles, 2–5 words. **No opaque codes** (`WS-*`, `Phase N`, `M1`, `Q3-2026`). Title Case for display, kebab-case for filenames. If scope can't be named in 5 words, decompose. Done historical phases (`Phase 1` … `Phase 6`) keep numbered names for accuracy — rule applies forward only.

`Workstream` is the custom Project field used for cross-repo phase grouping; GitHub's built-in `Milestone` field is **not** used.

## Markdown follow-up trackers (deprecated)

Old `docs/` root trackers (`book-catalog-follow-ups.md`, `ws-rt-follow-ups.md`, `post-launch-followups.md`) and per-task follow-up docs are deprecated. Surviving items migrate to issues. **Do not create new follow-up `.md` docs.**

## Model selection (Claude-driven filing)

| Operation                                | Model           |
| ---------------------------------------- | --------------- |
| Incidental find mid-session (1–2 issues) | Opus inline     |
| Bulk filing from a precise brief         | Haiku subagent  |
| Mixed decision + execution batches       | Sonnet subagent |
| Triage migration of legacy md trackers   | **Opus**        |
| Audit doc → issues batch                 | Sonnet subagent |
| Crowdin / dependency-PR auto-labeling    | Haiku subagent  |

Default Opus inline; escalate down only when the operation matches.
