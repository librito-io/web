import pino, {
  type DestinationStream,
  type Logger,
  stdTimeFunctions,
} from "pino";
import { AsyncLocalStorage } from "node:async_hooks";
import { REDACTED_FIELDS } from "$lib/sentry-scrub";

interface LogContext {
  requestId: string;
  route?: string;
  method?: string;
}

const als = new AsyncLocalStorage<LogContext>();

let testDestination: DestinationStream | undefined;

function makeBase(): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      // Base names derive from REDACTED_FIELDS (the Sentry scrub list) so
      // the two redaction layers stay in sync by construction — add new
      // fields there, not here. Pino's `*` glob matches a single path
      // segment — `*.field` covers nested fields (e.g. `req.token`) but
      // not top-level `token`, hence both forms per name.
      redact: {
        paths: [
          ...REDACTED_FIELDS.flatMap((f) => [f, `*.${f}`]),
          "req.headers.authorization",
          "req.headers.cookie",
        ],
        censor: "[REDACTED]",
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: stdTimeFunctions.isoTime,
    },
    testDestination,
  );
}

let base: Logger = makeBase();

export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function logger(): Logger {
  const ctx = als.getStore();
  return ctx ? base.child(ctx) : base;
}

/**
 * @internal — test-only. Swaps the underlying pino destination with a
 * synchronous write callback so tests can assert on captured JSON.
 */
export function __setTestDestination(write: (line: string) => void): void {
  testDestination = {
    write(chunk: string) {
      write(chunk.trimEnd());
    },
  } as DestinationStream;
  base = makeBase();
}

/**
 * @internal — test-only. Restores the default stdout destination.
 */
export function __resetTestDestination(): void {
  testDestination = undefined;
  base = makeBase();
}
