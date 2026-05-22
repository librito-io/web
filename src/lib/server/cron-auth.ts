import { createHash, timingSafeEqual } from "node:crypto";
import { jsonError } from "$lib/server/errors";

/**
 * Constant-time string equality for cron-auth comparisons.
 *
 * Both inputs are SHA-256 hashed to fixed-width 32-byte buffers before
 * `crypto.timingSafeEqual`. Hashing both sides eliminates length-based
 * leakage even via the constant-time path itself: `timingSafeEqual` throws
 * on length mismatch, which would re-introduce a length oracle if we
 * compared the raw inputs. With both sides hashed the buffers are always
 * the same width regardless of input length, and the engine has no
 * `.length`/`.charCodeAt` short-circuit on the original strings to
 * exploit.
 */
export function constantTimeEqualString(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Canonical cron-auth gate for every cron / cron-pattern handler.
 *
 * Returns a `Response` to short-circuit the handler on failure, or `null`
 * when the request is authorized and the caller should proceed (typically
 * to the `?probe=1` short-circuit, then real work — see CLAUDE.md
 * "Cron handlers").
 *
 * Two failure modes:
 *   500 server_misconfigured — `CRON_SECRET` env var unset (config drift).
 *                              Surfaces loudly rather than 401'ing every
 *                              fire silently.
 *   401 unauthorized         — `Authorization: Bearer <secret>` missing or
 *                              mismatched. Constant-time compared via
 *                              `constantTimeEqualString`.
 */
export function authorizeCronRequest(
  request: Request,
  secret: string | undefined,
): Response | null {
  if (!secret) {
    return jsonError(500, "server_misconfigured", "CRON_SECRET unset");
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!constantTimeEqualString(auth, `Bearer ${secret}`)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }
  return null;
}
