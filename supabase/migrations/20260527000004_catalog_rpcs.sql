-- 20260527000004_catalog_rpcs.sql
--
-- Four RPCs powering the refit replay + admin surfaces:
--   _field_replay_due(timestamptz, text)        — STABLE TTL-ladder helper
--   select_replay_candidates(int)               — replay cron's row picker
--   promote_ta_to_isbn(text, text)              — TA→ISBN row promotion
--   requeue_catalog_resolve(uuid, text[])       — per-field reset + clear values
--   admin_apply_action(uuid,uuid,text,jsonb)    — atomic UPDATE + audit INSERT
--
-- All SECURITY INVOKER; service-role-only EXECUTE.

-- TTL ladder for the per-field replay predicate. Declared STABLE (not
-- IMMUTABLE) because it calls now() — Postgres rejects IMMUTABLE wrappers
-- over STABLE functions. Inlined CASE keeps the predicate transparent and
-- avoids an interval-as-arg pattern that complicated an earlier draft.
--
-- Boundary semantics: strict `>` is intentional — a row exactly at its
-- TTL becomes due on the NEXT cron tick rather than the current one.
-- At cron cadence (daily) the one-tick latency is invisible. Mirrors
-- the > comparison in shouldAttempt() in src/lib/server/catalog/chain.ts
-- (PR2) so SQL + TS predicates agree on boundary rows.
CREATE FUNCTION public._field_replay_due(
  p_attempted_at timestamptz, p_fail_reason text
) RETURNS boolean LANGUAGE sql STABLE
SET search_path = public AS $$
  SELECT CASE
    WHEN p_attempted_at IS NULL                                THEN TRUE
    WHEN p_fail_reason  IS NULL                                THEN FALSE
    WHEN p_fail_reason IN ('rate_limited','transient_error')   THEN now() - p_attempted_at > interval '1 hour'
    WHEN p_fail_reason  = 'provider_disabled'                  THEN now() - p_attempted_at > interval '24 hours'
    WHEN p_fail_reason  = 'provider_empty_field'               THEN now() - p_attempted_at > interval '30 days'
    WHEN p_fail_reason IN ('provider_no_data','exhausted')     THEN now() - p_attempted_at > interval '90 days'
    ELSE FALSE
  END;
$$;

REVOKE EXECUTE ON FUNCTION public._field_replay_due(timestamptz, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._field_replay_due(timestamptz, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._field_replay_due(timestamptz, text) TO service_role;

-- Replay-cron candidates. Returns id + lookup keys + replay_fields (the
-- subset of tracked fields whose TTL is up) so the cron can scope its
-- requeue precisely. Ordered by last_attempted_at ASC (oldest first;
-- last_attempted_at is NOT NULL DEFAULT now() so no NULL branch).
--
-- CTE materialises each <field>_due boolean once per row so the
-- SELECT-side replay_fields construction and the WHERE filter reference
-- the same predicate. Avoids drift between SELECT and WHERE on future
-- TTL or field-semantic edits.
CREATE FUNCTION public.select_replay_candidates(p_limit int)
RETURNS TABLE (
  id uuid, isbn text, normalized_title_author text,
  title text, author text, replay_fields text[]
) LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public AS $$
  WITH due AS (
    SELECT
      bc.id, bc.isbn, bc.normalized_title_author, bc.title, bc.author,
      bc.last_attempted_at,
      (bc.storage_path   IS NULL AND _field_replay_due(bc.cover_attempted_at,          bc.cover_fail_reason))          AS cover_due,
      (bc.description    IS NULL AND _field_replay_due(bc.description_attempted_at,    bc.description_fail_reason))    AS description_due,
      (bc.publisher      IS NULL AND _field_replay_due(bc.publisher_attempted_at,      bc.publisher_fail_reason))      AS publisher_due,
      (bc.published_date IS NULL AND _field_replay_due(bc.published_date_attempted_at, bc.published_date_fail_reason)) AS published_date_due,
      (bc.subjects       IS NULL AND _field_replay_due(bc.subjects_attempted_at,       bc.subjects_fail_reason))       AS subjects_due,
      (bc.page_count     IS NULL AND _field_replay_due(bc.page_count_attempted_at,     bc.page_count_fail_reason))     AS page_count_due
    FROM book_catalog bc
  )
  SELECT
    due.id, due.isbn, due.normalized_title_author, due.title, due.author,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN due.cover_due          THEN 'cover'          END,
      CASE WHEN due.description_due    THEN 'description'    END,
      CASE WHEN due.publisher_due      THEN 'publisher'      END,
      CASE WHEN due.published_date_due THEN 'published_date' END,
      CASE WHEN due.subjects_due       THEN 'subjects'       END,
      CASE WHEN due.page_count_due     THEN 'page_count'     END
    ], NULL) AS replay_fields
  FROM due
  WHERE due.cover_due
     OR due.description_due
     OR due.publisher_due
     OR due.published_date_due
     OR due.subjects_due
     OR due.page_count_due
  ORDER BY due.last_attempted_at ASC
  LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION public.select_replay_candidates(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.select_replay_candidates(int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.select_replay_candidates(int) TO service_role;

-- Atomically promote a TA-keyed row to ISBN-keyed. Returns true if a row
-- was promoted; false if no matching TA row OR if an ISBN-keyed row for
-- p_isbn already exists (unique_violation caught — caller falls through
-- to fresh cold-resolve, identical to "no TA row" path). Orphan TA row
-- left as-is; duplicate-row sweeper deferred (out-of-refit follow-up).
CREATE FUNCTION public.promote_ta_to_isbn(p_isbn text, p_ta_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  UPDATE book_catalog
     SET isbn = p_isbn
   WHERE isbn IS NULL
     AND normalized_title_author = p_ta_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
EXCEPTION
  WHEN unique_violation THEN
    RETURN false;
END $$;

REVOKE EXECUTE ON FUNCTION public.promote_ta_to_isbn(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_ta_to_isbn(text, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.promote_ta_to_isbn(text, text) TO service_role;

-- Per-field reset that nulls value AND state columns AND (for description)
-- clears do_not_refetch_description. Without value-column null, the
-- resolver's COALESCE upsert preserves stale text — see memory note
-- feedback_catalog_reset_sql_misses_flag for prior incident. Cover also
-- flips pending_storage = TRUE so the upload step refires.
--
-- Cover storage-orphan posture: nulling storage_path leaves prior CF /
-- Supabase Storage objects behind. sha256 dedup in persistCover prevents
-- double-upload on identical bytes; differing bytes create a new object.
-- Acceptable pre-launch; sweeper deferred (follow-up).
--
-- *_attempts semantics: lifetime counter — intentionally NOT reset by
-- requeue. PR2's resolver finalize increments existing+1 on every walk;
-- the column accumulates the all-time attempt count so the replay
-- system can observe pathological retry loops (a row whose attempts
-- climb without ever populating signals a structural data gap). If a
-- future audit-doc decides per-resolve semantics is wanted, switch
-- here AND in the resolver applyFieldResult helper together.
CREATE FUNCTION public.requeue_catalog_resolve(p_id uuid, p_fields text[])
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(p_fields) f
     WHERE f NOT IN ('cover','description','publisher','published_date','subjects','page_count')
  ) THEN
    RAISE EXCEPTION 'unknown field in p_fields: %', p_fields;
  END IF;

  UPDATE book_catalog
     SET
       -- cover
       storage_path                = CASE WHEN 'cover' = ANY(p_fields) THEN NULL ELSE storage_path END,
       cover_storage_backend       = CASE WHEN 'cover' = ANY(p_fields) THEN NULL ELSE cover_storage_backend END,
       image_sha256                = CASE WHEN 'cover' = ANY(p_fields) THEN NULL ELSE image_sha256 END,
       cover_max_width             = CASE WHEN 'cover' = ANY(p_fields) THEN NULL ELSE cover_max_width END,
       cover_source                = CASE WHEN 'cover' = ANY(p_fields) THEN NULL ELSE cover_source END,
       cover_attempted_at          = CASE WHEN 'cover' = ANY(p_fields) THEN NULL ELSE cover_attempted_at END,
       cover_fail_reason           = CASE WHEN 'cover' = ANY(p_fields) THEN NULL ELSE cover_fail_reason END,
       pending_storage             = CASE WHEN 'cover' = ANY(p_fields) THEN TRUE ELSE pending_storage END,
       -- description (+ clear takedown flag)
       description                 = CASE WHEN 'description' = ANY(p_fields) THEN NULL ELSE description END,
       description_raw             = CASE WHEN 'description' = ANY(p_fields) THEN NULL ELSE description_raw END,
       description_provider        = CASE WHEN 'description' = ANY(p_fields) THEN NULL ELSE description_provider END,
       description_attempted_at    = CASE WHEN 'description' = ANY(p_fields) THEN NULL ELSE description_attempted_at END,
       description_fail_reason     = CASE WHEN 'description' = ANY(p_fields) THEN NULL ELSE description_fail_reason END,
       do_not_refetch_description  = CASE WHEN 'description' = ANY(p_fields) THEN FALSE ELSE do_not_refetch_description END,
       -- publisher
       publisher                   = CASE WHEN 'publisher' = ANY(p_fields) THEN NULL ELSE publisher END,
       publisher_provider          = CASE WHEN 'publisher' = ANY(p_fields) THEN NULL ELSE publisher_provider END,
       publisher_attempted_at      = CASE WHEN 'publisher' = ANY(p_fields) THEN NULL ELSE publisher_attempted_at END,
       publisher_fail_reason       = CASE WHEN 'publisher' = ANY(p_fields) THEN NULL ELSE publisher_fail_reason END,
       -- published_date
       published_date              = CASE WHEN 'published_date' = ANY(p_fields) THEN NULL ELSE published_date END,
       published_date_provider     = CASE WHEN 'published_date' = ANY(p_fields) THEN NULL ELSE published_date_provider END,
       published_date_attempted_at = CASE WHEN 'published_date' = ANY(p_fields) THEN NULL ELSE published_date_attempted_at END,
       published_date_fail_reason  = CASE WHEN 'published_date' = ANY(p_fields) THEN NULL ELSE published_date_fail_reason END,
       -- subjects
       subjects                    = CASE WHEN 'subjects' = ANY(p_fields) THEN NULL ELSE subjects END,
       subjects_provider           = CASE WHEN 'subjects' = ANY(p_fields) THEN NULL ELSE subjects_provider END,
       subjects_attempted_at       = CASE WHEN 'subjects' = ANY(p_fields) THEN NULL ELSE subjects_attempted_at END,
       subjects_fail_reason        = CASE WHEN 'subjects' = ANY(p_fields) THEN NULL ELSE subjects_fail_reason END,
       -- page_count
       page_count                  = CASE WHEN 'page_count' = ANY(p_fields) THEN NULL ELSE page_count END,
       page_count_provider         = CASE WHEN 'page_count' = ANY(p_fields) THEN NULL ELSE page_count_provider END,
       page_count_attempted_at     = CASE WHEN 'page_count' = ANY(p_fields) THEN NULL ELSE page_count_attempted_at END,
       page_count_fail_reason      = CASE WHEN 'page_count' = ANY(p_fields) THEN NULL ELSE page_count_fail_reason END
   WHERE id = p_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.requeue_catalog_resolve(uuid, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.requeue_catalog_resolve(uuid, text[]) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.requeue_catalog_resolve(uuid, text[]) TO service_role;

-- Atomic admin-action mutation + audit-row INSERT. Snapshots full row
-- pre + post mutation into before_jsonb / after_jsonb (~2 KB per row).
-- One transaction; never orphans audit from mutation. FOR UPDATE locks
-- the row so a concurrent resolver-side update can't slip between the
-- pre-snapshot and the post-snapshot.
CREATE FUNCTION public.admin_apply_action(
  p_admin_user_id uuid,
  p_catalog_id    uuid,
  p_action        text,
  p_patch_jsonb   jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_before   jsonb;
  v_after    jsonb;
  v_audit_id uuid;
  v_isbn     text;
  v_ta_key   text;
BEGIN
  IF p_action NOT IN ('save_description','takedown','upload_cover','set_isbn','requeue') THEN
    RAISE EXCEPTION 'unknown admin action: %', p_action;
  END IF;

  SELECT row_to_json(bc.*)::jsonb, bc.isbn, bc.normalized_title_author
    INTO v_before, v_isbn, v_ta_key
    FROM book_catalog bc
   WHERE bc.id = p_catalog_id
   FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'catalog row not found: %', p_catalog_id;
  END IF;

  CASE p_action
    WHEN 'save_description' THEN
      UPDATE book_catalog
         SET description                = p_patch_jsonb->>'description',
             description_provider       = 'manual',
             do_not_refetch_description = TRUE,
             description_attempted_at   = now(),
             description_fail_reason    = NULL
       WHERE id = p_catalog_id;
    WHEN 'takedown' THEN
      UPDATE book_catalog
         SET description                = NULL,
             description_raw            = NULL,
             description_provider       = NULL,
             do_not_refetch_description = TRUE,
             description_attempted_at   = now()
       WHERE id = p_catalog_id;
    WHEN 'upload_cover' THEN
      -- Required-key validation. Without these guards an empty {} patch
      -- would null every storage column while flipping cover_source =
      -- 'manual' + pending_storage = FALSE, leaving the row claiming a
      -- manual cover with no storage backing (and emitting a misleading
      -- success audit).
      IF p_patch_jsonb->>'storage_path' IS NULL
         OR p_patch_jsonb->>'cover_storage_backend' IS NULL
         OR p_patch_jsonb->>'image_sha256' IS NULL
         OR p_patch_jsonb->>'cover_max_width' IS NULL THEN
        RAISE EXCEPTION 'upload_cover requires non-null storage_path / cover_storage_backend / image_sha256 / cover_max_width in p_patch_jsonb';
      END IF;
      UPDATE book_catalog
         SET storage_path           = p_patch_jsonb->>'storage_path',
             cover_storage_backend  = p_patch_jsonb->>'cover_storage_backend',
             image_sha256           = p_patch_jsonb->>'image_sha256',
             cover_max_width        = (p_patch_jsonb->>'cover_max_width')::int,
             cover_source           = 'manual',
             pending_storage        = FALSE,
             cover_attempted_at     = now(),
             cover_fail_reason      = NULL
       WHERE id = p_catalog_id;
    WHEN 'set_isbn' THEN
      IF v_isbn IS NOT NULL THEN
        RAISE EXCEPTION 'set_isbn requires TA-keyed row (isbn already populated)';
      END IF;
      IF v_ta_key IS NULL THEN
        RAISE EXCEPTION 'set_isbn requires normalized_title_author on row';
      END IF;
      -- Without this guard, promote_ta_to_isbn(NULL, v_ta_key) would
      -- match the TA row (the UPDATE's `isbn IS NULL` predicate is
      -- satisfied), perform a NULL→NULL no-op write, return true, and
      -- emit an audit row claiming a successful set_isbn with
      -- after_jsonb.isbn = NULL.
      IF p_patch_jsonb->>'isbn' IS NULL THEN
        RAISE EXCEPTION 'set_isbn requires non-null isbn in p_patch_jsonb';
      END IF;
      IF NOT (SELECT promote_ta_to_isbn(p_patch_jsonb->>'isbn', v_ta_key)) THEN
        RAISE EXCEPTION 'promote_ta_to_isbn returned false (ISBN already exists or no TA row matched)';
      END IF;
    WHEN 'requeue' THEN
      -- requeue_catalog_resolve already validates each field name via
      -- its own allowlist; nothing additional to check here. An empty
      -- p_patch_jsonb->'fields' (missing or empty array) results in a
      -- no-op UPDATE — acceptable as a no-op admin action; the audit
      -- row records the empty fields list.
      PERFORM requeue_catalog_resolve(
        p_catalog_id,
        ARRAY(SELECT jsonb_array_elements_text(p_patch_jsonb->'fields'))
      );
  END CASE;

  SELECT row_to_json(bc.*)::jsonb INTO v_after
    FROM book_catalog bc WHERE bc.id = p_catalog_id;

  INSERT INTO catalog_admin_actions
    (admin_user_id, catalog_id, isbn, action, before_jsonb, after_jsonb)
  VALUES
    (p_admin_user_id, p_catalog_id, COALESCE(v_after->>'isbn', v_isbn),
     p_action, v_before, v_after)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.admin_apply_action(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_apply_action(uuid, uuid, text, jsonb) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_apply_action(uuid, uuid, text, jsonb) TO service_role;
