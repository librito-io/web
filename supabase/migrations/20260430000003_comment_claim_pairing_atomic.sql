-- COMMENT for claim_pairing_atomic (see 20260430000001).
-- Split per-statement to dodge a Supabase CLI v2.90 multi-statement
-- parser bug; see footer of 20260430000001 for context.

COMMENT ON FUNCTION public.claim_pairing_atomic IS
  'Atomic pairing claim and device upsert. Eliminates the race class where '
  'concurrent callers observe the post-claim, pre-device-insert window. '
  'Caller (src/lib/server/pairing.ts) writes Redis after this returns '
  'won=true; on Redis failure invokes rollback_claim_pairing. Service-role '
  'only. See docs/audits/2026-04-29-server-helpers.md issue B-atomic.';
