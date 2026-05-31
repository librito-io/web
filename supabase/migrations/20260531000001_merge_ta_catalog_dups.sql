-- 20260531000001_merge_ta_catalog_dups.sql
--
-- Dedup remedy for issue #489 Fix C: collapse multiple title+author
-- (ISBN-less) catalog rows that are the same book into one survivor.
--
-- Two dup origins, both handled here (the issue's "device-spelling out of
-- scope" note is superseded — see PR / #489 discussion):
--   1. Drift dups   — key drifted from title/author (Fix A/B prevent new
--                      ones; this cleans existing).
--   2. Spelling dups — distinct valid keys, same book ("1984" vs
--                      "Nineteen Eighty-Four") from divergent device sync.
--                      No heuristic can reliably tell these are one book, so
--                      the SURVIVOR IS CHOSEN BY THE OPERATOR (admin UI /
--                      TS caller), not by this RPC. The RPC is a dumb,
--                      audited, transactional executor: keep survivor,
--                      delete losers wholesale (no field merge — see #489
--                      Decision 2: a field merge would graft a wrong-edition
--                      cover while #490 is open).
--
-- Audit: catalog_admin_actions.catalog_id → book_catalog(id) is ON DELETE
-- CASCADE, so a loser's own prior audit rows would vanish when it is
-- deleted, and an audit row keyed to the loser would too. To preserve
-- history attached to the surviving row, the RPC (a) re-parents each
-- loser's existing audit rows to the survivor, then (b) writes one
-- 'merge_ta_dup' audit row per loser (catalog_id = survivor, before = the
-- full loser row, after = { merged_into }), then (c) deletes the loser.
--
-- SECURITY INVOKER + service-role-only EXECUTE, mirroring admin_apply_action.
-- The admin-gate (profiles.is_admin) backs up the SvelteKit requireAdmin
-- form-action boundary in case a future call site invokes the RPC directly.

-- The merge writes a 'merge_ta_dup' audit row; extend the action CHECK
-- (defined inline in 20260527000003) to admit it. Drop-by-auto-name then
-- re-add named so the constraint is explicit/greppable from here on.
ALTER TABLE catalog_admin_actions
  DROP CONSTRAINT catalog_admin_actions_action_check;
ALTER TABLE catalog_admin_actions
  ADD CONSTRAINT catalog_admin_actions_action_check CHECK (action IN
    ('save_description','takedown','upload_cover','set_isbn','requeue','merge_ta_dup'));

CREATE OR REPLACE FUNCTION public.merge_ta_catalog_dups(
  p_admin_user_id uuid,
  p_survivor_id   uuid,
  p_loser_ids     uuid[]
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_survivor_isbn text;
  v_survivor_key  text;
  v_loser_id      uuid;
  v_loser_row     jsonb;
  v_loser_isbn    text;
  v_count         integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_admin_user_id AND is_admin
  ) THEN
    RAISE EXCEPTION 'merge_ta_catalog_dups: % is not an admin', p_admin_user_id;
  END IF;

  IF p_loser_ids IS NULL OR array_length(p_loser_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'merge_ta_catalog_dups: no loser ids supplied (empty)';
  END IF;

  IF p_survivor_id = ANY (p_loser_ids) THEN
    RAISE EXCEPTION 'merge_ta_catalog_dups: cannot merge a row into itself (survivor present in loser list)';
  END IF;

  -- Lock + validate the survivor. TA-dup remedy only: an ISBN-keyed row is
  -- deduped by its own unique constraint, not here.
  SELECT bc.isbn, bc.normalized_title_author
    INTO v_survivor_isbn, v_survivor_key
    FROM book_catalog bc
   WHERE bc.id = p_survivor_id
   FOR UPDATE;
  IF v_survivor_key IS NULL AND v_survivor_isbn IS NULL THEN
    RAISE EXCEPTION 'merge_ta_catalog_dups: survivor row not found: %', p_survivor_id;
  END IF;
  IF v_survivor_isbn IS NOT NULL THEN
    RAISE EXCEPTION 'merge_ta_catalog_dups: survivor must be a TA-keyed row (isbn is null), got isbn=%', v_survivor_isbn;
  END IF;

  FOREACH v_loser_id IN ARRAY p_loser_ids LOOP
    -- Lock + snapshot the loser; enforce TA-keyed.
    SELECT row_to_json(bc.*)::jsonb, bc.isbn
      INTO v_loser_row, v_loser_isbn
      FROM book_catalog bc
     WHERE bc.id = v_loser_id
     FOR UPDATE;
    IF v_loser_row IS NULL THEN
      RAISE EXCEPTION 'merge_ta_catalog_dups: loser row not found: %', v_loser_id;
    END IF;
    IF v_loser_isbn IS NOT NULL THEN
      RAISE EXCEPTION 'merge_ta_catalog_dups: loser must be a TA-keyed row (isbn is null), got id=% isbn=%', v_loser_id, v_loser_isbn;
    END IF;

    -- (a) Re-parent the loser's prior audit history to the survivor so the
    --     CASCADE on delete doesn't erase it.
    UPDATE catalog_admin_actions
       SET catalog_id = p_survivor_id
     WHERE catalog_id = v_loser_id;

    -- (b) Record the merge, attached to the survivor (the loser id is about
    --     to disappear).
    INSERT INTO catalog_admin_actions
      (admin_user_id, catalog_id, isbn, action, before_jsonb, after_jsonb)
    VALUES
      (p_admin_user_id, p_survivor_id, NULL, 'merge_ta_dup',
       v_loser_row,
       jsonb_build_object('merged_into', p_survivor_id));

    -- (c) Delete the loser.
    DELETE FROM book_catalog WHERE id = v_loser_id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

REVOKE EXECUTE ON FUNCTION public.merge_ta_catalog_dups(uuid, uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.merge_ta_catalog_dups(uuid, uuid, uuid[]) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.merge_ta_catalog_dups(uuid, uuid, uuid[]) TO service_role;
