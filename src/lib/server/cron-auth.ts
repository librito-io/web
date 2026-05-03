import { createHash, timingSafeEqual } from "node:crypto";

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
