import { isValidEmail, normalizeEmail } from "$lib/server/newsletter";

const MAX_MESSAGE = 5000;

export type ContactValidation =
  | { ok: true; email: string; message: string }
  | { ok: false; error: string };

export function validateContactInput(raw: {
  email: unknown;
  message: unknown;
}): ContactValidation {
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
  return { ok: true, email, message };
}
