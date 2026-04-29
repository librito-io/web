-- ============================================================
-- DEVELOPMENT SEED DATA
-- ============================================================
-- Run after creating a test user via Supabase Dashboard > Auth.
-- Usage: paste into SQL Editor after creating the test user.
-- Replace the user UUID below with the actual test user's ID.

DO $$
DECLARE
  v_user_id    uuid;
  v_device_id  uuid;
  v_book1_id   uuid;
  v_book2_id   uuid;
  v_hl1_id     uuid;
  v_hl2_id     uuid;
  v_hl3_id     uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'test@example.com';
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'No test user found. Create test@example.com via Dashboard first.';
    RETURN;
  END IF;

  -- Device
  INSERT INTO devices (user_id, hardware_id, name, api_token_hash, last_synced_at)
  VALUES (v_user_id, 'seed-device-001', 'Dev Reader', 'SEED-NOT-A-REAL-HASH-DO-NOT-REPLACE-WITH-REAL-HEX', now())
  RETURNING id INTO v_device_id;

  -- Book 1
  INSERT INTO books (user_id, book_hash, title, author, language, isbn)
  VALUES (v_user_id, 'da4c5f2e', 'Leviathan Wakes', 'James S.A. Corey', 'en', '9780316129084')
  RETURNING id INTO v_book1_id;

  -- Book 2
  INSERT INTO books (user_id, book_hash, title, author, language, isbn)
  VALUES (v_user_id, 'b7e3a1f0', 'Project Hail Mary', 'Andy Weir', 'en', '9780593135204')
  RETURNING id INTO v_book2_id;

  -- Highlights for book 1
  INSERT INTO highlights (book_id, user_id, chapter_index, start_word, end_word,
                          text, chapter_title, device_timestamp_raw)
  VALUES (v_book1_id, v_user_id, 3, 1024, 1078,
          'The protomolecule spread through the station like a wave, reshaping everything it touched into something alien and purposeful.',
          'Chapter 3: The Broken Planet', 1712345678)
  RETURNING id INTO v_hl1_id;

  INSERT INTO highlights (book_id, user_id, chapter_index, start_word, end_word,
                          text, chapter_title, device_timestamp_raw)
  VALUES (v_book1_id, v_user_id, 7, 2050, 2098,
          'Miller understood then that the case had never been about finding Julie Mao. It had been about finding himself.',
          'Chapter 7: Miller', 1712400000)
  RETURNING id INTO v_hl2_id;

  -- Highlight for book 2
  INSERT INTO highlights (book_id, user_id, chapter_index, start_word, end_word,
                          text, chapter_title, device_timestamp_raw)
  VALUES (v_book2_id, v_user_id, 1, 100, 145,
          'I penetrated the outer cell membrane with a nanotube. I feel like this is a metaphor for something, but I can''t quite put my finger on it.',
          'Chapter 1', 1712500000)
  RETURNING id INTO v_hl3_id;

  -- Notes
  INSERT INTO notes (highlight_id, user_id, text)
  VALUES (v_hl1_id, v_user_id, 'Key foreshadowing — the protomolecule has intent, not just spread');

  INSERT INTO notes (highlight_id, user_id, text)
  VALUES (v_hl2_id, v_user_id, 'Miller''s arc in one sentence — the detective who was really looking for himself');

  INSERT INTO notes (highlight_id, user_id, text)
  VALUES (v_hl3_id, v_user_id, 'Classic Weir humor');

  -- Pending transfer
  INSERT INTO book_transfers (user_id, device_id, filename, file_size, storage_path, sha256)
  VALUES (v_user_id, v_device_id, 'The Martian.epub', 1250000,
          v_user_id || '/seed-transfer/The Martian.epub',
          'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2');

  RAISE NOTICE 'Seed data created: 1 device, 2 books, 3 highlights, 2 notes, 1 transfer';
END;
$$;
