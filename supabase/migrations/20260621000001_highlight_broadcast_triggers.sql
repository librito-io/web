-- Live Highlight Feed — web <- DB Broadcast path (area:realtime, area:feed).
-- Spec: docs/superpowers/specs/2026-06-20-live-highlight-feed-design.md
--
-- Two AFTER triggers on public.highlights emit a Supabase Realtime Broadcast
-- to the private per-user topic `user:<user_id>` on insert and on the
-- deleted_at transition (trash/restore). The browser feed subscribes to that
-- topic and refetches enriched rows through get_highlight_feed — the broadcast
-- is a SIGNAL, not a data source.
--
-- highlights is deliberately NOT added to supabase_realtime: this uses
-- Broadcast (authorize once at subscribe), not postgres_changes (re-evaluates
-- RLS per subscriber per change — the documented scaling bottleneck, and needs
-- REPLICA IDENTITY FULL). See spec §1.
--
-- == SECURITY DEFINER is load-bearing (spec risk #1) — DO NOT DOWNGRADE ========
-- realtime.send() is SECURITY INVOKER and INSERTs into realtime.messages, which
-- has RLS ENABLED with ZERO INSERT policies; anon/authenticated are not
-- BYPASSRLS. A SECURITY INVOKER trigger firing under an `authenticated` writer
-- would run realtime.send as authenticated -> the messages INSERT is RLS-denied
-- and SILENTLY SWALLOWED (realtime.send wraps its INSERT in
-- EXCEPTION WHEN OTHERS THEN RAISE WARNING — spec §3), breaking the broadcast
-- invisibly. Today every highlights writer is service_role (BYPASSRLS), so an
-- INVOKER trigger would happen to work; it becomes load-bearing the moment any
-- authenticated highlights-write path is added (e.g. if web#530 implements
-- trash as an authenticated own-row UPDATE policy instead of a service_role
-- action). SECURITY DEFINER (owner postgres, BYPASSRLS) is correct either way.
-- =============================================================================
--
-- == Down migration (manual; we do not ship .down.sql) ========================
--   DROP TRIGGER IF EXISTS highlights_broadcast_insert ON public.highlights;
--   DROP TRIGGER IF EXISTS highlights_broadcast_update ON public.highlights;
--   DROP FUNCTION IF EXISTS public.broadcast_highlight_insert();
--   DROP FUNCTION IF EXISTS public.broadcast_highlight_update();
--   DROP POLICY IF EXISTS "authenticated read own highlight topic"
--     ON realtime.messages;
-- =============================================================================

-- INSERT — statement-level: one broadcast per import (even a 1000-row bulk
-- sync), zero on a no-op ON CONFLICT re-send (conflict-updated rows route to
-- the UPDATE path and are excluded from the AFTER INSERT transition table).
CREATE OR REPLACE FUNCTION public.broadcast_highlight_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER                         -- load-bearing; see header
SET search_path = pg_catalog, public
AS $$
DECLARE r record;
BEGIN
  -- DISTINCT user_id defends the (theoretical) multi-user statement; every
  -- real import is single-user, so this emits one message.
  FOR r IN SELECT DISTINCT user_id FROM inserted LOOP
    PERFORM realtime.send(
      jsonb_build_object('op', 'insert'),  -- contentless signal; client refetches head
      'highlight_change',
      'user:' || r.user_id,
      true                                 -- private
    );
  END LOOP;
  RETURN NULL;
END $$;

-- UPDATE — row-level, guarded to deleted_at transitions only. The WHEN guard
-- is load-bearing: processSync re-sends the full set and DO UPDATEs every row
-- plus the update_updated_at trigger bumps every change; without the guard
-- every sync would emit a no-op broadcast per row.
CREATE OR REPLACE FUNCTION public.broadcast_highlight_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER                         -- load-bearing; see header
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('op', 'update', 'id', NEW.id, 'deleted_at', NEW.deleted_at),
    'highlight_change',
    'user:' || NEW.user_id,
    true
  );
  RETURN NULL;
END $$;

-- DROP-then-CREATE so a local `supabase db reset` re-run is clean.
DROP TRIGGER IF EXISTS highlights_broadcast_insert ON public.highlights;
CREATE TRIGGER highlights_broadcast_insert
  AFTER INSERT ON public.highlights
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.broadcast_highlight_insert();

DROP TRIGGER IF EXISTS highlights_broadcast_update ON public.highlights;
CREATE TRIGGER highlights_broadcast_update
  AFTER UPDATE ON public.highlights
  FOR EACH ROW
  WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.broadcast_highlight_update();

-- Two-REVOKE template (CLAUDE.md "Function EXECUTE grants"). Trigger-only
-- functions still fire after revocation (PostgreSQL exempts triggers from
-- EXECUTE checks); neither has a legitimate PostgREST caller.
REVOKE EXECUTE ON FUNCTION public.broadcast_highlight_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.broadcast_highlight_insert() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.broadcast_highlight_insert() TO service_role;

REVOKE EXECUTE ON FUNCTION public.broadcast_highlight_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.broadcast_highlight_update() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.broadcast_highlight_update() TO service_role;

COMMENT ON FUNCTION public.broadcast_highlight_insert() IS
  'Live feed: statement-level AFTER INSERT broadcast to private topic user:<user_id>. SECURITY DEFINER is load-bearing — see migration header / spec risk #1. One message per import; zero on a no-op ON CONFLICT re-send.';
COMMENT ON FUNCTION public.broadcast_highlight_update() IS
  'Live feed: row-level AFTER UPDATE broadcast (deleted_at transition only) to private topic user:<user_id>. SECURITY DEFINER is load-bearing — see migration header / spec risk #1.';

-- realtime.messages RLS: a client may receive only its own per-user topic.
-- realtime.messages already has RLS ENABLED with zero policies (verified
-- 2026-06-21); this adds the single SELECT policy. The migration role
-- (postgres) has rights to create policies in the realtime schema — the
-- documented Supabase pattern for private channels.
CREATE POLICY "authenticated read own highlight topic"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (realtime.topic() = 'user:' || (SELECT auth.uid())::text);
