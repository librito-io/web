import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Creates a mock Supabase client with chainable query builder.
 * Usage:
 *   const mock = createMockSupabase();
 *   mock._results.set('pairing_codes.insert', { data: { id: 'abc' }, error: null });
 *   await requestPairingCode(mock, 'hw-1');
 */
export function createMockSupabase() {
  const results = new Map<string, { data: unknown; error: unknown }>();

  function makeChain(table: string, operation: string) {
    const key = `${table}.${operation}`;
    const chain: Record<string, unknown> = {};

    const terminal = () => {
      const result = results.get(key) ?? { data: null, error: null };
      return Promise.resolve(result);
    };

    // Every method returns the chain, except terminal methods
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_, prop: string) {
        if (prop === "then") return undefined; // not a thenable
        if (prop === "single" || prop === "maybeSingle") return terminal;
        return (..._args: unknown[]) => new Proxy(chain, handler);
      },
    };

    return new Proxy(chain, handler);
  }

  const client = {
    from: (table: string) => ({
      insert: (..._args: unknown[]) => makeChain(table, "insert"),
      select: (..._args: unknown[]) => makeChain(table, "select"),
      update: (..._args: unknown[]) => makeChain(table, "update"),
      upsert: (..._args: unknown[]) => makeChain(table, "upsert"),
      delete: (..._args: unknown[]) => makeChain(table, "delete"),
    }),
    _results: results,
  };

  return client as unknown as SupabaseClient & {
    _results: Map<string, { data: unknown; error: unknown }>;
  };
}

/** Mock Redis with in-memory store */
export function createMockRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();

  return {
    set: vi.fn(async (key: string, value: string, opts?: { ex?: number }) => {
      const expiresAt = opts?.ex ? Date.now() + opts.ex * 1000 : Infinity;
      store.set(key, { value, expiresAt });
      return "OK";
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    _store: store,
  };
}
