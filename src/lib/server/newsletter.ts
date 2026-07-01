import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "$lib/types/database";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Deliberately conservative: one @, a dot in the domain, no whitespace, and
// the RFC 5321 254-char max length. The authoritative check is
// deliverability at send time; this only rejects obvious garbage before we
// touch the DB.
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Insert a signup, ignoring duplicates. `fresh` is true only when a new row
 * was written (so the caller sends the welcome email exactly once per email).
 * Uses upsert(ignoreDuplicates) which emits INSERT ... ON CONFLICT DO NOTHING;
 * `.select()` returns the inserted row on success and nothing on conflict.
 */
export async function processNewsletterSignup(
  supabase: SupabaseClient<Database>,
  rawEmail: string,
  locale: string | null,
): Promise<{ fresh: boolean }> {
  const email = normalizeEmail(rawEmail);
  const { data, error } = await supabase
    .from("newsletter_signups")
    .upsert({ email, locale }, { onConflict: "email", ignoreDuplicates: true })
    .select("id");

  if (error) {
    throw new Error(`newsletter insert failed: ${error.message}`);
  }
  return { fresh: (data?.length ?? 0) > 0 };
}
