// Helpers for working with Supabase RPC return shapes.

/**
 * Extracts the first row from a `supabase.rpc(...)` result whose Postgres
 * function uses `RETURNS TABLE(...)` (or otherwise returns rowset shape).
 *
 * Centralized because the Supabase JS client types `.rpc()` data as the loose
 * `Json` shape and individual call sites tended to repeat an `Array.isArray`
 * coercion plus an `as` cast. Folding that into one helper keeps the
 * narrowing rule (and any future runtime guards) consistent across the
 * codebase.
 *
 * Always treats input as an array — `RETURNS TABLE` returns a JSON array
 * even for zero or one rows. Callers must still validate the row's shape;
 * see `claimPairingCode` for the runtime-guard pattern when schema drift
 * would silently corrupt downstream behaviour.
 */
export function firstRow<T>(rows: unknown): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] as T;
}
