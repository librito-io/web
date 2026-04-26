<!--
  PR body = reviewer surface (lives in GitHub UI, ephemeral).
  Per-commit messages = the durable archeology; squash auto-concats them
  into the merge commit body via repo setting `COMMIT_MESSAGES`.

  Keep this body slim. Put what + why + how-it-was-built in commit messages.
  Put what reviewers + ops need *while the PR is open* here.
-->

## Summary

<!-- 1-3 sentences. What changed and why. Link to spec / issue if relevant. -->

## Test plan

- [ ] `npm run check` (0 errors)
- [ ] `npx vitest run` (all pass)
- [ ] Manual smoke: <golden-path scenario>
- [ ] Manual smoke: <edge-case scenario>

## Deploy / migration notes

<!-- Only if this PR touches supabase/migrations/, env vars, cron, RLS, or
     anything Vercel deploy doesn't auto-apply. Otherwise delete this section. -->

- [ ] After merge: `supabase migration list` then `supabase db push`
- [ ] Env var changes: <list>
- [ ] Rollback plan: <if non-trivial>

## Reviewer notes

<!-- Anything that helps a reviewer scan this faster. Trade-offs you
     considered, alternatives rejected, follow-ups already filed.
     Delete this section if there's nothing non-obvious. -->
