-- WS-RT-adjacent: enable Realtime on book_transfers.
--
-- Split out from 20260426000001 (notes tombstones) because book_transfers
-- Realtime is consumed by the WS-C firmware client, not by WS-RT proper.
-- Keeping it in its own migration makes scope obvious in `git blame` and
-- lets WS-C ship without rewriting WS-RT history.
--
-- Why FULL replica identity: web/firmware subscribers want the post-image
-- (status flips, last_error fills) without a round-trip SELECT. Default
-- (primary key only) would force every UPDATE event to be followed by a
-- SELECT to read the new state. WAL-amplification cost is negligible on
-- this low-write table (one row per upload, status changes at most a
-- handful of times in its lifecycle).
--
-- RLS: book_transfers SELECT policy scopes by auth.uid() = user_id.
-- Realtime evaluates RLS per-subscriber, so FULL pre-image broadcast does
-- NOT leak across users.

ALTER TABLE public.book_transfers REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'book_transfers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.book_transfers;
  END IF;
END $$;
