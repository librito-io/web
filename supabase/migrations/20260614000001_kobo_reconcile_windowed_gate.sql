-- Kobo reconcile windowed amend gate — librito-io/web#533.
--
-- Reverses web#532's "always amend a matched absent row". The stamp
-- removed_from_device_at becomes load-bearing: amend only when the absent row
-- is unstamped OR stamped within the grace window W (removed_from_device_at >
-- p_cutoff). Beyond W → a true delete-then-rehighlight → insert fresh (the
-- archived row keeps its note, created_at, deleted_at, and stamp).
--
-- Signature changes (adds p_cutoff, p_complete) — DROP + recreate (Postgres
-- cannot CREATE OR REPLACE across argument lists). The 3-arg function shipped
-- only in #532; this migration replaces it (function-only, no column change —
-- removed_from_device_at already exists).
--
-- Stamping scope also broadens (spec §4):
--   (a) p_complete=true drops the covered-book restriction so a whole-book wipe
--       and a total-device wipe ({items:[], complete:true}) stamp the user's
--       entire kobo set. Missing ⇒ false (covered-only — graceful degradation).
--   (b) trashed rows are stamped too (drop deleted_at IS NULL from 3a/3b) so the
--       windowed gate binds them — else a web-trashed, device-deleted, much-later
--       re-highlighted passage would amend the trashed row and stay invisible.
--
-- ── Down migration (manual; we do not ship .down.sql) ────────────────────────
--   DROP FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb, timestamptz, boolean);
--   -- then re-apply 20260611000001 to restore the 3-arg form.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb);

CREATE FUNCTION public.reconcile_kobo_highlights(
  p_user_id  uuid,
  p_rows     jsonb,
  p_amends   jsonb,
  p_cutoff   timestamptz,
  p_complete boolean
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
  -- UNCHANGED from 20260611000001.
  SELECT count(DISTINCT i.source_uid) INTO v_xbook
    FROM jsonb_to_recordset(p_rows) AS i(book_id uuid, source_uid text)
    JOIN public.highlights h
      ON h.source_uid = i.source_uid
     AND h.book_id   <> i.book_id
   WHERE h.user_id = p_user_id
     AND h.source  = 'kobo';

  -- STEP 1: AMENDS. As 20260611000001, PLUS the windowed precondition: the
  -- absent row must be unstamped OR stamped within W (removed_from_device_at >
  -- p_cutoff). A stale-stamped row (beyond W) fails the precondition and the
  -- item falls through to STEP 2 as a plain insert — the safe direction. This
  -- mirrors the matcher's candidacy exclusion as an in-transaction re-check.
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
     -- WINDOWED amend precondition (spec §3): unstamped or within W.
     AND (h.removed_from_device_at IS NULL OR h.removed_from_device_at > p_cutoff)
     AND NOT EXISTS (
       SELECT 1 FROM incoming i
        WHERE i.book_id = h.book_id AND i.source_uid = h.source_uid
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.highlights h2
        WHERE h2.user_id    = p_user_id
          AND h2.book_id    = h.book_id
          AND h2.source     = 'kobo'
          AND h2.source_uid = a.source_uid
          AND h2.id        <> h.id
     );
  GET DIAGNOSTICS v_amended = ROW_COUNT;

  -- STEP 2: UPSERT the full incoming set. UNCHANGED from 20260611000001.
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
  WHERE highlights.user_id = p_user_id
    AND (highlights.text          IS DISTINCT FROM EXCLUDED.text
      OR highlights.chapter_title IS DISTINCT FROM
         COALESCE(EXCLUDED.chapter_title, highlights.chapter_title));

  -- STEP 3a: SET stamps. First observed absence. CHANGES vs 20260611000001:
  --   * deleted_at IS NULL dropped → trashed rows are stamped too (spec §4b),
  --     so the windowed gate binds them.
  --   * p_complete=true drops the covered-book restriction (spec §4a) → stamps
  --     the user's whole kobo set (absence still via NOT EXISTS against p_rows).
  --     On empty p_rows + p_complete=true, incoming is empty → every kobo row is
  --     absent → total-device-wipe stamp-only. p_complete=false ⇒ covered-only.
  -- Transition guard (removed_from_device_at IS NULL) → one bump per removal.
  WITH incoming AS (
    SELECT DISTINCT book_id, source_uid
    FROM jsonb_to_recordset(p_rows) AS r(book_id uuid, source_uid text)
  ),
  covered AS (SELECT DISTINCT book_id FROM incoming)
  UPDATE public.highlights h
     SET removed_from_device_at = now()
   WHERE h.user_id = p_user_id
     AND h.source  = 'kobo'
     AND h.removed_from_device_at IS NULL
     AND (p_complete OR h.book_id IN (SELECT book_id FROM covered))
     AND NOT EXISTS (
       SELECT 1 FROM incoming i
        WHERE i.book_id = h.book_id AND i.source_uid = h.source_uid
     );
  GET DIAGNOSTICS v_stamped = ROW_COUNT;

  -- STEP 3b: CLEAR stamps on reappearance. CHANGE: deleted_at IS NULL dropped
  -- (symmetric with 3a) so a trashed row that reappears also clears.
  WITH incoming AS (
    SELECT DISTINCT book_id, source_uid
    FROM jsonb_to_recordset(p_rows) AS r(book_id uuid, source_uid text)
  )
  UPDATE public.highlights h
     SET removed_from_device_at = NULL
   WHERE h.user_id = p_user_id
     AND h.source  = 'kobo'
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

-- service_role only (two-REVOKE template, NEW 5-arg signature).
REVOKE EXECUTE ON FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb, timestamptz, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb, timestamptz, boolean) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_kobo_highlights(uuid, jsonb, jsonb, timestamptz, boolean) TO service_role;
