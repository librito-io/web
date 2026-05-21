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
 * hooks. Caveat: never swallows the result — `update()` is always called
 * (after retry exhaustion), so server `fail()` payloads surface on the
 * page's `form` prop and the form stays open until the caller explicitly
 * closes it from `onSuccess`.
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

      if (result.type === "success") {
        await opts.onSuccess?.();
      } else if (result.type === "error") {
        await opts.onError?.();
      }
      await update();
    };
  };
}
