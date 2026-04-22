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
  const storageResults = new Map<string, { data: unknown; error: unknown }>();

  function makeChain(table: string, operation: string) {
    const key = `${table}.${operation}`;
    const chain: Record<string, unknown> = {};

    const terminal = () => {
      const raw = results.get(key) ?? { data: null, error: null };
      // Mirror real Supabase: .single()/.maybeSingle() returns a scalar row.
      // Tests often set `data: []` or `data: [row]` on the same select key
      // (because the handler also uses it for non-terminal awaits); unwrap
      // the first element (or null) so `.maybeSingle()` semantics match.
      const data = Array.isArray(raw.data) ? (raw.data[0] ?? null) : raw.data;
      return Promise.resolve({ data, error: raw.error });
    };

    // Every method returns the chain, except terminal methods.
    // The chain is thenable so `await supabase.from(...).update(...).eq(...)` resolves
    // to the mock result even without a trailing `.single()` call.
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_, prop: string) {
        if (prop === "then") {
          const result = results.get(key) ?? { data: null, error: null };
          return (onFulfilled: (value: unknown) => unknown) =>
            Promise.resolve(onFulfilled(result));
        }
        if (prop === "single" || prop === "maybeSingle") return terminal;
        return (..._args: unknown[]) => new Proxy(chain, handler);
      },
    };

    return new Proxy(chain, handler);
  }

  function storageBucket(_bucket: string) {
    return {
      createSignedUploadUrl: async (..._args: unknown[]) =>
        storageResults.get("createSignedUploadUrl") ?? {
          data: { signedUrl: "https://mock/upload" },
          error: null,
        },
      createSignedUrl: async (..._args: unknown[]) =>
        storageResults.get("createSignedUrl") ?? {
          data: { signedUrl: "https://mock/download" },
          error: null,
        },
      remove: async (..._args: unknown[]) =>
        storageResults.get("remove") ?? { data: null, error: null },
      list: async (..._args: unknown[]) =>
        storageResults.get("list") ?? { data: [], error: null },
    };
  }

  const client = {
    from: (table: string) => ({
      insert: (..._args: unknown[]) => makeChain(table, "insert"),
      select: (..._args: unknown[]) => makeChain(table, "select"),
      update: (..._args: unknown[]) => makeChain(table, "update"),
      upsert: (..._args: unknown[]) => makeChain(table, "upsert"),
      delete: (..._args: unknown[]) => makeChain(table, "delete"),
    }),
    storage: { from: storageBucket },
    _results: results,
    _storage: storageResults,
  };

  return client as unknown as SupabaseClient & {
    _results: Map<string, { data: unknown; error: unknown }>;
    _storage: Map<string, { data: unknown; error: unknown }>;
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
