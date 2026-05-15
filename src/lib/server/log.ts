import pino, {
  type DestinationStream,
  type Logger,
  stdTimeFunctions,
} from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

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
      // Pino's `*` glob matches a single path segment — `*.token` covers
      // nested fields (e.g. `req.token`) but not top-level `token`. List
      // both root and nested forms so a future contributor doesn't shrink
      // the list and silently lose top-level redaction.
      redact: {
        paths: [
          "token",
          "*.token",
          "api_token_hash",
          "*.api_token_hash",
          "password",
          "*.password",
          "email",
          "*.email",
          "privateKey",
          "*.privateKey",
          "jwk",
          "*.jwk",
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
