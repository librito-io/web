import { fail } from "@sveltejs/kit";
import type { Actions } from "./$types";
import { validateContactInput } from "$lib/server/contact";
import { contactLimiter, safeLimit } from "$lib/server/ratelimit";
import { sendContactEmail } from "$lib/server/email";

export const actions: Actions = {
  contact: async ({ request, getClientAddress }) => {
    const form = await request.formData();

    // Honeypot — return success without sending so bots learn nothing.
    const company = form.get("company");
    if (typeof company === "string" && company.trim() !== "") {
      return { ok: true };
    }

    const parsed = validateContactInput({
      name: form.get("name"),
      email: form.get("email"),
      message: form.get("message"),
      reason: form.get("reason"),
    });
    if (!parsed.ok) return fail(400, { error: parsed.error });

    const outcome = await safeLimit(contactLimiter, getClientAddress());
    if (outcome.kind === "failClosed") {
      return fail(503, {
        error: "Service temporarily unavailable. Please try again shortly.",
      });
    }
    if (outcome.kind === "ok" && !outcome.result.success) {
      return fail(429, { error: "Too many messages. Please try again later." });
    }

    const sent = await sendContactEmail(
      parsed.name,
      parsed.email,
      parsed.message,
      parsed.reason,
    );
    if (!sent) {
      return fail(502, {
        error: "Couldn't send your message. Please try again shortly.",
      });
    }
    return { ok: true };
  },
};
