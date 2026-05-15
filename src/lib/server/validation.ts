// Strict UUID v4 regex. Route params accepted by `/api/pair/*` and
// `/api/transfer/*` are either client-supplied hardware identifiers
// (validated against this shape) or server-generated row ids from
// `gen_random_uuid()`, which always emits v4. Reject anything else at
// the handler boundary so probe traffic 404s deterministically instead
// of generating Postgres 22P02 parse errors against `book_transfers.id`
// / `pairing_codes.id` lookups.
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
