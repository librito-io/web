-- 20260527000008_admin_apply_action_admin_gate.sql
--
-- Defense-in-depth gate inside `admin_apply_action`: reject any
-- p_admin_user_id that does not correspond to a `profiles` row with
-- is_admin = TRUE. Today the load-bearing boundary is the SvelteKit
-- `requireAdmin` form-action helper; this RPC-level guard backs it up
-- in case a future call site (operator script, internal tooling,
-- webhook) forgets the application-layer gate or invokes the RPC
-- directly with service-role credentials.
--
-- Issue #445 / surfaced by branch-review of PR #444.

CREATE OR REPLACE FUNCTION public.admin_apply_action(
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
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_admin_user_id AND is_admin
  ) THEN
    RAISE EXCEPTION 'admin_apply_action: % is not an admin', p_admin_user_id;
  END IF;

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
      IF p_patch_jsonb->>'isbn' IS NULL THEN
        RAISE EXCEPTION 'set_isbn requires non-null isbn in p_patch_jsonb';
      END IF;
      IF NOT (SELECT promote_ta_to_isbn(p_patch_jsonb->>'isbn', v_ta_key)) THEN
        RAISE EXCEPTION 'promote_ta_to_isbn returned false (ISBN already exists or no TA row matched)';
      END IF;
    WHEN 'requeue' THEN
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

-- CREATE OR REPLACE preserves prior grants, but reaffirm explicitly so
-- the privilege posture is visible in this migration for future audits.
REVOKE EXECUTE ON FUNCTION public.admin_apply_action(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_apply_action(uuid, uuid, text, jsonb) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_apply_action(uuid, uuid, text, jsonb) TO service_role;
