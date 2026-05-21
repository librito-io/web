import { describe, it, expect, vi, beforeEach } from "vitest";

// Node-environment test (no jsdom dep). All assertions target the
// mocked Sentry surface — init args + handleErrorWithSentry wrap call —
// so the real browser SDK never executes. Plan-blessed fallback when
// jsdom mocking is unworkable; full browser-runtime validation happens
// via the manual preview-deploy DevTools smoke (see runbook).

const init = vi.fn();
const handleErrorWithSentry = vi.fn((fallback: unknown): unknown => fallback);
vi.mock("@sentry/sveltekit", () => ({
  init,
  handleErrorWithSentry,
}));

beforeEach(() => {
  init.mockReset();
  handleErrorWithSentry.mockReset();
  handleErrorWithSentry.mockImplementation((fallback) => fallback);
  vi.resetModules();
});

describe("src/hooks.client.ts", () => {
  it("does NOT call Sentry.init when PUBLIC_SENTRY_DSN is unset", async () => {
    vi.doMock("$env/dynamic/public", () => ({
      env: {
        PUBLIC_SENTRY_DSN: "",
        PUBLIC_VERCEL_ENV: "preview",
        PUBLIC_VERCEL_GIT_COMMIT_SHA: "abc123",
      },
    }));
    await import("../../src/hooks.client");
    expect(init).not.toHaveBeenCalled();
  });

  it("calls Sentry.init when PUBLIC_SENTRY_DSN is set, with PII off and tracing off", async () => {
    vi.doMock("$env/dynamic/public", () => ({
      env: {
        PUBLIC_SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
        PUBLIC_VERCEL_ENV: "production",
        PUBLIC_VERCEL_GIT_COMMIT_SHA: "deadbeef",
      },
    }));
    await import("../../src/hooks.client");
    expect(init).toHaveBeenCalledTimes(1);
    const [opts] = init.mock.calls[0] as [Record<string, unknown>];
    expect(opts.dsn).toBe("https://abc@o123.ingest.sentry.io/456");
    expect(opts.environment).toBe("production");
    expect(opts.release).toBe("deadbeef");
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.replaysSessionSampleRate).toBe(0);
    expect(opts.replaysOnErrorSampleRate).toBe(0);
    expect(opts.sendDefaultPii).toBe(false);
    expect(typeof opts.beforeSend).toBe("function");
  });

  it("defaults environment to 'development' when PUBLIC_VERCEL_ENV unset", async () => {
    vi.doMock("$env/dynamic/public", () => ({
      env: {
        PUBLIC_SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
      },
    }));
    await import("../../src/hooks.client");
    expect(init).toHaveBeenCalledTimes(1);
    const [opts] = init.mock.calls[0] as [Record<string, unknown>];
    expect(opts.environment).toBe("development");
  });

  it("exports handleError wrapped via Sentry.handleErrorWithSentry", async () => {
    vi.doMock("$env/dynamic/public", () => ({
      env: {
        PUBLIC_SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
      },
    }));
    const mod = await import("../../src/hooks.client");
    expect(handleErrorWithSentry).toHaveBeenCalledTimes(1);
    expect(typeof mod.handleError).toBe("function");
  });
});
