import { isValidEmail, normalizeEmail } from "$lib/server/newsletter";

const MAX_MESSAGE = 5000;
const MAX_NAME = 200;

// Routing hint that drives the outbound email subject. Deliberately lenient:
// an unknown/missing value coerces to "other" rather than rejecting, so a
// malformed reason never blocks a legitimate support message.
export type ContactReason = "bug" | "feature" | "other";
const CONTACT_REASONS: readonly ContactReason[] = ["bug", "feature", "other"];

function normalizeReason(raw: unknown): ContactReason {
  return typeof raw === "string" &&
    (CONTACT_REASONS as readonly string[]).includes(raw)
    ? (raw as ContactReason)
    : "other";
}

export type ContactValidation =
  | {
      ok: true;
      name: string;
      email: string;
      message: string;
      reason: ContactReason;
    }
  | { ok: false; error: string };

export function validateContactInput(raw: {
  name: unknown;
  email: unknown;
  message: unknown;
  reason?: unknown;
}): ContactValidation {
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    return { ok: false, error: "A name is required" };
  }
  const name = raw.name.trim();
  if (name.length > MAX_NAME) {
    return { ok: false, error: "Name is too long" };
  }
  if (typeof raw.email !== "string") {
    return { ok: false, error: "A valid email is required" };
  }
  const email = normalizeEmail(raw.email);
  if (!isValidEmail(email)) {
    return { ok: false, error: "A valid email is required" };
  }
  if (typeof raw.message !== "string" || raw.message.trim() === "") {
    return { ok: false, error: "A message is required" };
  }
  const message = raw.message.trim();
  if (message.length > MAX_MESSAGE) {
    return { ok: false, error: "Message is too long" };
  }
  return {
    ok: true,
    name,
    email,
    message,
    reason: normalizeReason(raw.reason),
  };
}
