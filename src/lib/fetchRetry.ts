import type { SubmitFunction } from "@sveltejs/kit";

export async function fetchWithSafariRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    // Safari/WebKit reuses idle HTTP keep-alive sockets the server already
    // closed; first request fails mid-flight with "Load failed" / "network
    // connection was lost". Retry once on a fresh connection.
    return await fetch(input, init);
  }
}

export type SafariRetryEnhanceOptions = {
  /** Runs only on `result.type === "success"`. Use to close forms, reset state, etc. */
  onSuccess?: () => void | Promise<void>;
  /** Runs only on `result.type === "error"` after the retry has been exhausted. Use to surface a fallback network-error message. */
  onError?: () => void | Promise<void>;
};

/**
 * `use:enhance` callback that retries once on Safari/WebKit's stale
 * keep-alive socket bug, then routes the final result through caller
 * hooks.
 *
 * Three deviations from a naive `await update()` everywhere:
 *
 *  - On `result.type === "error"` we skip `update()` entirely. SvelteKit's
 *    default `applyAction` on an error result triggers the nearest
 *    `+error.svelte` boundary, which would replace the page with a 500
 *    screen and clobber per-form recovery state.
 *  - On `result.type === "failure"` we call `update({ invalidateAll:
 *    false })`. Default behavior re-runs `load`; for a per-row form
 *    inside a list (e.g. `{#each devices as device}{#if renamingId ===
 *    device.id}<form>...</form>{/if}{/each}`), invalidation can remove
 *    the very row the error block is rendered inside (server returned
 *    404 because the row was revoked concurrently) — taking the message
 *    with it. Skipping invalidation keeps the form mounted so the user
 *    sees the failure; a manual reload picks up the new list state.
 *  - On `result.type === "success"` we let `update()` invalidate so the
 *    list reflects the write.
 */
export function safariRetryEnhance(
  opts: SafariRetryEnhanceOptions = {},
): SubmitFunction {
  return ({ formElement }) => {
    return async ({ result, update }) => {
      if (result.type === "error" && !formElement.dataset.retried) {
        formElement.dataset.retried = "1";
        formElement.requestSubmit();
        return;
      }
      delete formElement.dataset.retried;

      if (result.type === "error") {
        await opts.onError?.();
        return;
      }

      if (result.type === "success") {
        await opts.onSuccess?.();
        await update();
        return;
      }

      // result.type === "failure" (or any remaining non-success/non-error)
      await update({ invalidateAll: false });
    };
  };
}
