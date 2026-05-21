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

  it("calls onError + update when error repeats after the retry", async () => {
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
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("calls update but not onSuccess on server-returned failure", async () => {
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
