-- Allow single-word highlights (audit PR 9: L2).
--
-- Background: 20260412000003 created highlights with
--   CONSTRAINT valid_word_range CHECK (end_word > start_word)
-- which assumes exclusive bounds (end is one-past-the-last word).
-- Device firmware actually uses INCLUSIVE bounds: end_word is the
-- index of the last selected word. Verified on 2026-04-29 against
-- librito-io/reader@main:
--   - reader/src/ui/screens/SelectionManager.cpp:257 filters words
--     with `providerIndex < lo || providerIndex > hi` — closed
--     interval, both endpoints inclusive.
--   - reader/test/unit/screens/SelectionManagerTest.cpp:240-241
--     ("getResult — single word selection") asserts
--     `startWordIndex == 2 && endWordIndex == 2` for a long-press +
--     immediate Save, i.e. the single-word path produces start==end.
--   - reader/src/cloud/SyncPayloadBuilder.cpp:227-228 forwards the
--     same indices to the cloud without adjustment.
--
-- The current `>` constraint therefore rejects every single-word
-- highlight at the DB layer. (Today the API in
-- src/lib/server/sync.ts also rejects them with the same
-- off-by-one — that is a paired follow-up tracked in the audit doc.)
--
-- Relaxing `>` to `>=` is safe regardless of whether the table
-- contains data: every row that satisfied `end_word > start_word`
-- also satisfies `end_word >= start_word`. Local verification:
--   SELECT min(end_word - start_word) FROM highlights;  -- 45
-- Production was not queried; the relaxation is monotonic so the
-- check holds without inspection.

ALTER TABLE public.highlights
  DROP CONSTRAINT valid_word_range,
  ADD CONSTRAINT valid_word_range CHECK (end_word >= start_word);

COMMENT ON CONSTRAINT valid_word_range ON public.highlights IS
  'Word indices are inclusive: end_word is the index of the last '
  'selected word, not one past it. A single-word highlight has '
  'end_word = start_word. Firmware source: '
  'librito-io/reader src/ui/screens/SelectionManager.cpp:257 '
  '(closed-interval filter) and src/ui/screens/SelectionManager.h '
  '(SelectionResult).';
