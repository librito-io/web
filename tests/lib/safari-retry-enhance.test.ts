import { describe, it, expect, vi } from "vitest";
import { safariRetryEnhance } from "../../src/lib/fetchRetry";

// Stub the `formElement` argument the SubmitFunction receives. The helper
// only needs `dataset` (string-keyed flag store) and `requestSubmit()` —
// no full HTMLFormElement is necessary.
function makeFormElement() {
  const dataset: Record<string, string> = {};
  const requestSubmit = vi.fn();
  return {
    dataset,
    requestSubmit,
  } as unknown as HTMLFormElement & {
    dataset: Record<string, string>;
    requestSubmit: ReturnType<typeof vi.fn>;
  };
}

function buildCompletion(
  result:
    | { type: "success"; status?: number; data?: unknown }
    | { type: "failure"; status?: number; data?: unknown }
    | { type: "error"; error: unknown }
    | { type: "redirect"; status: number; location: string },
) {
  const update = vi.fn(async () => {});
  return {
    completion: { result, update },
    update,
  };
}

describe("safariRetryEnhance", () => {
  it("retries once on first error and skips onError/update during the retry leg", async () => {
    const onError = vi.fn();
    const callback = safariRetryEnhance({ onError });

    const formElement = makeFormElement();
    const submit = callback({ formElement } as never) as (
      e: unknown,
    ) => Promise<void>;

    const { completion, update } = buildCompletion({
      type: "error",
      error: new Error("network"),
    });
    await submit(completion);

    expect(formElement.dataset.retried).toBe("1");
    expect(formElement.requestSubmit).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("calls onError and SKIPS update when error repeats after the retry", async () => {
    // Why skip update: SvelteKit's default `applyAction` on an error
    // result triggers the nearest `+error.svelte` boundary, swapping
    // the page for a 500 screen and wiping any per-form recovery state
    // the caller set in `onError`. Hit live during PR #341 smoke — the
    // unpair-offline path rendered "500 Failed to fetch" instead of the
    // per-row "Network error" message. Regression-guarded here.
    const onError = vi.fn();
    const callback = safariRetryEnhance({ onError });

    const formElement = makeFormElement();
    formElement.dataset.retried = "1"; // simulate post-retry submission
    const submit = callback({ formElement } as never) as (
      e: unknown,
    ) => Promise<void>;

    const { completion, update } = buildCompletion({
      type: "error",
      error: new Error("network"),
    });
    await submit(completion);

    expect(formElement.dataset.retried).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("calls update with invalidateAll:false on server-returned failure", async () => {
    // Why invalidateAll:false: for per-row forms inside a list (e.g.
    // `{#each devices}{#if renamingId === device.id}<form>...</form>{/if}{/each}`),
    // default invalidation re-runs `load` and can remove the very row
    // whose error block is rendered inside the form — taking the
    // message with it. Hit live during PR #341 smoke when a device was
    // revoked concurrently between rename-form-open and Save: server
    // returned 404, load re-ran without the row, form vanished, user
    // saw nothing. Regression-guarded here.
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const callback = safariRetryEnhance({ onSuccess, onError });

    const formElement = makeFormElement();
    const submit = callback({ formElement } as never) as (
      e: unknown,
    ) => Promise<void>;

    const { completion, update } = buildCompletion({
      type: "failure",
      status: 400,
      data: { error: "Name must be 50 characters or less" },
    });
    await submit(completion);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ invalidateAll: false });
  });

  it("calls onSuccess and update on result.type === success", async () => {
    const onSuccess = vi.fn();
    const callback = safariRetryEnhance({ onSuccess });

    const formElement = makeFormElement();
    const submit = callback({ formElement } as never) as (
      e: unknown,
    ) => Promise<void>;

    const { completion, update } = buildCompletion({
      type: "success",
      status: 200,
      data: { success: true },
    });
    await submit(completion);

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("clears the retried dataset flag after a successful retry", async () => {
    // Simulates: 1st submit blows up (error), helper sets `retried=1` and
    // re-fires; 2nd submit succeeds. The flag must be cleared so the next
    // user-initiated submit on the same form gets a fresh retry budget.
    const onSuccess = vi.fn();
    const callback = safariRetryEnhance({ onSuccess });

    const formElement = makeFormElement();
    formElement.dataset.retried = "1";
    const submit = callback({ formElement } as never) as (
      e: unknown,
    ) => Promise<void>;

    const { completion } = buildCompletion({
      type: "success",
      status: 200,
      data: { success: true },
    });
    await submit(completion);

    expect(formElement.dataset.retried).toBeUndefined();
  });

  it("does not throw when no handler options are supplied", async () => {
    const callback = safariRetryEnhance();
    const formElement = makeFormElement();
    const submit = callback({ formElement } as never) as (
      e: unknown,
    ) => Promise<void>;

    const { completion, update } = buildCompletion({
      type: "success",
      status: 200,
      data: { success: true },
    });
    await expect(submit(completion)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
