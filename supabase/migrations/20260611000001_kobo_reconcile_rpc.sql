-- Kobo import reconcile — librito-io/web#527.
--
-- Librito web is an ARCHIVE, not a device mirror. Device-side deletes never
-- set deleted_at or hide a web row (web#502 closed not-planned). The only
-- destructive-adjacent power here is converting a device span RE-DRAG — which
-- Nickel implements as hard DELETE + recreate → fresh BookmarkID → fresh
-- source_uid — into an in-place AMEND of the existing row, so the feed shows
-- one amended highlight (keeping its id, created_at, deleted_at, and any
-- web-authored note) instead of an accumulating duplicate.
--
-- This migration:
--   1. ADDs the inert removed_from_device_at metadata column.
--   2. CREATEs reconcile_kobo_highlights, which replaces upsert_kobo_highlights
--      in the import flow. The old RPC is KEPT (unused) one release for
--      rollback; a follow-up migration drops it.
--
-- ── Down migration (manual; we do not ship .down.sql) ────────────────────────
--   DROP FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb);
--   ALTER TABLE highlights DROP COLUMN removed_from_device_at;
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Inert removal metadata. No index (no read path in v1).
ALTER TABLE highlights ADD COLUMN removed_from_device_at timestamptz;
COMMENT ON COLUMN highlights.removed_from_device_at IS
  'Kobo reconcile: FIRST observed absent from a full-set import that covered '
  'its book (transition-guarded — never refreshed while absent; do not "fix" '
  'the guard to refresh it, that reinstates per-import write amplification). '
  'Inert metadata — no feed/RPC predicate READS it, but the WRITE is not free: '
  'setting it fires update_updated_at, so a first-observed removal bumps '
  'updated_at and re-syncs/Realtime-emits the row (bounded by the transition '
  'guard — one bump per removal, not per import; accepted per spec §5). NULL '
  'means "never observed removed", NOT "still on device" (whole-book removal '
  'never stamps).';

-- 2. The reconcile RPC. One transaction, three steps IN ORDER: amends →
-- upsert → stamps. EVERY step filters user_id = p_user_id AND source = 'kobo'
-- explicitly — the RPC runs as service_role (RLS bypassed); book_id implies
-- the user via per-user book resolve, but that is implicit and fragile, so the
-- explicit qual is the contract.
--
-- p_rows   : full incoming set — [{ book_id, source_uid, text, chapter_title, created_at }]
-- p_amends : matcher output     — [{ id, source_uid(NEW), text, chapter_title }]
-- Returns  : { amended, stamped, cleared, cross_book_uid_hits } counts (the
--            upsert changed-count stays internal).
CREATE FUNCTION public.reconcile_kobo_highlights(
  p_user_id uuid,
  p_rows    jsonb,
  p_amends  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_amended integer := 0;
  v_stamped integer := 0;
  v_cleared integer := 0;
  v_xbook   integer := 0;
BEGIN
  -- STEP 0: cross-book uid detector (instrumentation only — never a gate).
  -- Count DISTINCT incoming uids that already exist under a DIFFERENT book_id
  -- for this user — the cheap signal for the §7 book-re-resolution edge
  -- (#500/#503). Computed in-RPC (not via an orchestration .in("source_uid",
  -- allUids)) so a full-set re-POST of up to MAX_ITEMS=2000 uids never builds a
  -- ~72KB PostgREST URL or adds a round-trip. Runs FIRST, on the entry
  -- snapshot, so the import's own amends/inserts below can't inflate it.
  SELECT count(DISTINCT i.source_uid) INTO v_xbook
    FROM jsonb_to_recordset(p_rows) AS i(book_id uuid, source_uid text)
    JOIN public.highlights h
      ON h.source_uid = i.source_uid
     AND h.book_id   <> i.book_id
   WHERE h.user_id = p_user_id
     AND h.source  = 'kobo';

  -- STEP 1: AMENDS. UPDATE the existing row in place by id. KEEPS id (notes FK
  -- and future annotation-table FK survive), created_at (feed orders by it —
  -- taking the incoming timestamp would bump the row to feed-top on every span
  -- tweak), deleted_at (trashed stays trashed). p_amends.source_uid is the NEW
  -- uid; the row's current uid is the old one. chapter_title COALESCE matches
  -- step 2 exactly — if the two diverged, an amend would write a COALESCEd
  -- title and step 2's IS DISTINCT FROM would fire a second UPDATE re-clobber.
  -- Preconditions re-verified in-transaction (stale-snapshot safety): row owned
  -- by p_user_id, source='kobo', OLD uid still absent from the incoming set,
  -- NEW uid not already present for the book. Any violated precondition skips
  -- the amend; the item falls through to step 2 as a plain insert (worst case:
  -- one permanent duplicate — the safe direction).
  WITH amends AS (
    SELECT * FROM jsonb_to_recordset(p_amends) AS r(
      id            uuid,
      source_uid    text,
      text          text,
      chapter_title text
    )
  ),
  incoming AS (
    SELECT DISTINCT book_id, source_uid
    FROM jsonb_to_recordset(p_rows) AS r(book_id uuid, source_uid text)
  )
  UPDATE public.highlights h
     SET source_uid    = a.source_uid,
         text          = a.text,
         chapter_title = COALESCE(a.chapter_title, h.chapter_title)
    FROM amends a
   WHERE h.id      = a.id
     AND h.user_id = p_user_id
     AND h.source  = 'kobo'
     -- OLD uid still absent from the incoming set (NOT EXISTS, not NOT IN —
     -- a NULL in a NOT IN list silently voids the predicate).
     AND NOT EXISTS (
       SELECT 1 FROM incoming i
        WHERE i.book_id = h.book_id AND i.source_uid = h.source_uid
     )
     -- NEW uid not already present for this book.
     AND NOT EXISTS (
       SELECT 1 FROM public.highlights h2
        WHERE h2.user_id    = p_user_id
          AND h2.book_id    = h.book_id
          AND h2.source     = 'kobo'
          AND h2.source_uid = a.source_uid
          AND h2.id        <> h.id
     );
  GET DIAGNOSTICS v_amended = ROW_COUNT;

  -- STEP 2: UPSERT the full incoming set. Semantics of upsert_kobo_highlights
  -- (20260607000002) with ONE delta: chapter_title is COALESCEd so an incoming
  -- NULL (LEFT JOIN miss) preserves the stored title (archive posture: null
  -- means "unknown", never "erase"). The gate compares the post-COALESCE value
  -- so a no-op still skips the write and the update_updated_at trigger (#512).
  -- deleted_at + created_at untouched on conflict. An amended row's matched
  -- item is a guaranteed no-op here (its new uid + verbatim text landed in
  -- step 1, and the shared COALESCE makes chapter_title identical too).
  WITH input AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS r(
      book_id       uuid,
      source_uid    text,
      text          text,
      chapter_title text,
      created_at    timestamptz
    )
  )
  INSERT INTO public.highlights
    (book_id, user_id, source, source_uid, text, chapter_title, created_at)
  SELECT
    book_id, p_user_id, 'kobo', source_uid, text, chapter_title,
    COALESCE(created_at, now())
  FROM input
  ON CONFLICT (book_id, source, source_uid) WHERE source_uid IS NOT NULL
  DO UPDATE SET
    text          = EXCLUDED.text,
    chapter_title = COALESCE(EXCLUDED.chapter_title, highlights.chapter_title)
    -- deleted_at + created_at deliberately untouched on conflict — server owns
    -- soft-delete (trashed stays trashed); re-import must not rewrite origin time.
  WHERE highlights.user_id = p_user_id                       -- explicit owner qual (spec §5 contract)
    AND (highlights.text          IS DISTINCT FROM EXCLUDED.text
      OR highlights.chapter_title IS DISTINCT FROM
         COALESCE(EXCLUDED.chapter_title, highlights.chapter_title));

  -- STEP 3a: SET stamps. First observed absence of a LIVE row in a COVERED
  -- book. Transition-guarded (removed_from_device_at IS NULL) → no per-import
  -- write amplification. Amended rows now carry their NEW (incoming) uid, so
  -- they are present in `incoming` and never stamped. Trashed rows are never
  -- stamped (already hidden; stamp tracks live archive rows only).
  WITH incoming AS (
    SELECT DISTINCT book_id, source_uid
    FROM jsonb_to_recordset(p_rows) AS r(book_id uuid, source_uid text)
  ),
  covered AS (SELECT DISTINCT book_id FROM incoming)
  UPDATE public.highlights h
     SET removed_from_device_at = now()
   WHERE h.user_id = p_user_id
     AND h.source  = 'kobo'
     AND h.deleted_at IS NULL
     AND h.removed_from_device_at IS NULL
     AND h.book_id IN (SELECT book_id FROM covered)
     AND NOT EXISTS (
       SELECT 1 FROM incoming i
        WHERE i.book_id = h.book_id AND i.source_uid = h.source_uid
     );
  GET DIAGNOSTICS v_stamped = ROW_COUNT;

  -- STEP 3b: CLEAR stamps. A previously-absent uid reappeared in the incoming
  -- set. Transition-guarded (IS NOT NULL). Defensive only — a BookmarkID is
  -- minted once, so reappearance is near-impossible (multi-Kobo flicker, DB
  -- restores). Also fires for dedup-across-delete: re-highlighting an absent
  -- passage adopts its new uid, which IS in the incoming set.
  WITH incoming AS (
    SELECT DISTINCT book_id, source_uid
    FROM jsonb_to_recordset(p_rows) AS r(book_id uuid, source_uid text)
  )
  UPDATE public.highlights h
     SET removed_from_device_at = NULL
   WHERE h.user_id = p_user_id
     AND h.source  = 'kobo'
     AND h.deleted_at IS NULL                  -- stamp tracks LIVE rows only (symmetric with 3a)
     AND h.removed_from_device_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM incoming i
        WHERE i.book_id = h.book_id AND i.source_uid = h.source_uid
     );
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  RETURN jsonb_build_object(
    'amended', v_amended, 'stamped', v_stamped, 'cleared', v_cleared,
    'cross_book_uid_hits', v_xbook
  );
END;
$$;

-- service_role only: the import route uses the service-role client. No anon /
-- authenticated caller (two-REVOKE template per CLAUDE.md).
REVOKE EXECUTE ON FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb) TO service_role;
