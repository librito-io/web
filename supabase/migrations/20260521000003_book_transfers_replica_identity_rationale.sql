-- Document why book_transfers must keep REPLICA IDENTITY FULL.
--
-- Closes #106. The audit-doc finding proposed switching to USING INDEX
-- on a narrower projection. Investigation showed the swap is not safe:
--
--   1. RLS evaluation on DELETE needs `user_id` in the WAL old-image.
--      Without FULL the old-image is PK only, so the policy
--      `auth.uid() = user_id` cannot evaluate and Realtime drops the
--      event entirely.
--   2. The firmware subscriber filters on `device_id=eq.<id>` and
--      `device_id=is.null` (librito-io/reader src/cloud/RealtimeClient.cpp).
--      Status UPDATEs (pending → downloaded → expired → failed) do not
--      mutate `device_id`, so without FULL the filter column is absent
--      from the UPDATE payload and the firmware misses status flips.
--   3. USING INDEX requires UNIQUE + NOT NULL on every covered column.
--      `device_id` is nullable by schema, so no USING INDEX variant
--      narrower than FULL can cover both RLS and subscriber-filter needs.
--
-- WAL amplification cost is negligible: a low-write table with a handful
-- of status UPDATEs per transfer lifetime. Integration assertion lives
-- in tests/integration/realtime-publication.test.ts.

COMMENT ON TABLE public.book_transfers IS
  'EPUB upload queue. REPLICA IDENTITY FULL required for Supabase Realtime: RLS evaluates auth.uid() = user_id on DELETE (needs user_id in WAL old-image); firmware subscriber filters on device_id (nullable column, blocks USING INDEX). See migration 20260521000003 for full rationale and #106 close.';
