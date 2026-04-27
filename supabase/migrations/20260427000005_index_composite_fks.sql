-- Mitigate "Unindexed foreign keys" performance advisor warnings on
-- public.highlights, public.notes, and public.pairing_codes.
--
-- highlights has FK (book_id, user_id) → books(id, user_id). Existing
-- idx_highlights_book covers (book_id, chapter_index) — leading book_id
-- only; cascade DELETE from books has to filter user_id separately.
--
-- notes has FK (highlight_id, user_id) → highlights(id, user_id).
-- Existing UNIQUE(highlight_id) covers leading column only.
--
-- pairing_codes has FK user_id → profiles(id). No covering index;
-- cascade DELETE from profiles seq-scans pairing_codes. Tiny table in
-- practice (5-min TTL on rows) but no reason not to fix.
--
-- Cheap, eliminates advisor warnings, tiny throughput win on cascades.

CREATE INDEX IF NOT EXISTS idx_highlights_book_user
  ON public.highlights (book_id, user_id);

CREATE INDEX IF NOT EXISTS idx_notes_highlight_user
  ON public.notes (highlight_id, user_id);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_user
  ON public.pairing_codes (user_id);
