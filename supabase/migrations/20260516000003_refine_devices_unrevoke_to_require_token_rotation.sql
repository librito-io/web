-- Refine devices_prevent_unrevoke: enforce a token-level invariant rather
-- than a row-level one. Forward-only hot-fix on top of 20260516000002
-- (PR #181, commit 8aa6256). See issue #183 for the regression analysis.
--
-- Regression history:
--
--   PR #179 (commit be09c3a) added the "Users can update own devices" RLS
--   policy without narrowing column-level grants, opening three PATCH
--   vectors (api_token_hash mint, revoked_at clear, hardware_id forge) —
--   tracked as issue #180.
--
--   PR #181 (commit 8aa6256) closed those vectors with column-scoped
--   grants plus a trigger that treated revoked_at as one-way at the row
--   level: every OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
--   transition raised SQLSTATE 23514. That framing conflated two distinct
--   lifecycles —
--
--     (a) Token validity (api_token_hash currently in the row): one-way
--         per token. Once a specific hash is marked revoked, that hash
--         must never authenticate again.
--
--     (b) Binding state (this row reused across pair / unpair / re-pair
--         cycles via UNIQUE(user_id, hardware_id)): reversible. Each
--         re-pair rotates the token, overwriting the prior hash.
--
--   claim_pairing_atomic (20260430000001) encodes the legitimate re-pair
--   flow at lines 72-77: ON CONFLICT (user_id, hardware_id) DO UPDATE
--   SET api_token_hash = EXCLUDED.api_token_hash, revoked_at = NULL,
--   paired_at = now(). The new token is freshly minted; the old hash is
--   destroyed in the same UPDATE. The row's revoked_at clears because
--   the *new* token is not revoked, not because the *old* one is being
--   resurrected. PR #181's trigger blocked this flow, making re-pair of
--   any previously-unpaired device impossible.
--
-- The refined invariant:
--
--   A revoked token cannot be un-revoked. Clearing revoked_at requires
--   rotating api_token_hash in the same UPDATE.
--
--   IS NOT DISTINCT FROM is used instead of = so the NULL semantics are
--   explicit (NULL IS NOT DISTINCT FROM NULL = true). api_token_hash is
--   NOT NULL in the schema so the case is currently moot, but the
--   defensive form survives any future column-nullability change.
--
-- Why this beats the alternatives (full rationale in issue #183):
--
--   - Rolling back #181 reopens #180.
--   - A SET LOCAL GUC escape hatch ("trust this caller") expresses the
--     workaround rather than the invariant.
--   - Narrowing UNIQUE(user_id, hardware_id) to partial WHERE
--     revoked_at IS NULL plus a row-rewriting RPC discards the per-
--     device row continuity that #180's schema deliberately preserves.
--
--   The token-co-rotation form expresses the actual security property
--   directly. Same column grants, same policy, same row-reuse
--   semantics — only the function body changes.
--
-- Defence-in-depth layering, unchanged from #181:
--
--   1. GRANT UPDATE (name, revoked_at) to authenticated — PostgREST
--      denies any payload that touches api_token_hash before the trigger
--      fires. An attacker who patches {revoked_at: null,
--      api_token_hash: "x"} as authenticated is blocked by the grant.
--   2. Trigger — enforces the invariant for any caller that *does* have
--      the column grant, including service_role. Even service_role
--      cannot un-revoke without rotating the token.
--   3. RLS USING + WITH CHECK — gates row ownership.
--
-- Verifying after deploy (full cases in issue #183):
--
--   - PATCH {"revoked_at":null} as authenticated → 23514 (trigger).
--   - PATCH {"revoked_at":null,"api_token_hash":"x"} as authenticated
--     → PostgREST denies on column grant before trigger fires.
--   - claim_pairing_atomic re-pair against a revoked row → succeeds,
--     row re-paired, hash rotated.
--   - Service-role UPDATE SET revoked_at = NULL without rotating
--     api_token_hash → 23514 (trigger).
--
-- Forward-only: CREATE OR REPLACE FUNCTION replaces the body in place;
-- the trigger binding from #181 stays.

CREATE OR REPLACE FUNCTION public.devices_prevent_unrevoke()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS NULL
     AND OLD.api_token_hash IS NOT DISTINCT FROM NEW.api_token_hash THEN
    RAISE EXCEPTION 'devices.revoked_at cannot be cleared without rotating api_token_hash (use the pair-claim flow)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TRIGGER devices_prevent_unrevoke ON public.devices IS
  'A revoked token cannot be un-revoked. Clearing revoked_at requires rotating api_token_hash in the same UPDATE. Enforces a token-level invariant; the row itself is reusable across pair / unpair / re-pair cycles via claim_pairing_atomic''s ON CONFLICT path. Fires for all roles including service_role. Refined from the row-level form in 20260516000002 — see issue #183.';

COMMENT ON POLICY "Users can update own devices" ON public.devices IS
  'RLS gates row ownership only. Column scope (name, revoked_at) is enforced by the GRANT in 20260516000002; the token-co-rotation invariant on revoked_at is enforced by trigger devices_prevent_unrevoke (refined in 20260516000003). All three are required — do not relax the GRANT or drop the trigger without re-evaluating the column write surface.';
