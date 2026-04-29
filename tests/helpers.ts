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
  // Records every `.from(table).upsert(rows, opts)` invocation so tests can
  // assert payload shape (e.g. that a column is intentionally omitted).
  const upsertCalls: Array<{ table: string; rows: unknown; opts: unknown }> =
    [];

  function makeChain(table: string, operation: string, keySuffix = "") {
    const key = `${table}.${operation}${keySuffix}`;
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

  // Detect head-count selects like `.select("id", { count: "exact", head: true })`
  // and route them to a distinct key `<table>.select.count` so tests can mock
  // head-count results separately from array-data selects on the same table.
  function selectChain(table: string, args: unknown[]) {
    const opts = args[1] as { count?: string; head?: boolean } | undefined;
    if (opts && opts.head === true) {
      return makeChain(table, "select", ".count");
    }
    return makeChain(table, "select");
  }

  // Notes-specific select chain. processSync issues two select queries on
  // `notes` in the same Promise.all — one for live (`is('deleted_at', null)`)
  // and one for soft-deleted (`not('deleted_at', 'is', null)`). Tests need
  // to mock them separately, so route by the predicate the caller invokes.
  function makeNotesSelectChain(_args: unknown[]) {
    let isDeleted = false;
    const chain: Record<string, unknown> = {};

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_, prop: string) {
        if (prop === "then") {
          const key = isDeleted ? "notes.select.deleted" : "notes.select";
          const result = results.get(key) ?? { data: null, error: null };
          return (onFulfilled: (value: unknown) => unknown) =>
            Promise.resolve(onFulfilled(result));
        }
        if (prop === "single" || prop === "maybeSingle") {
          return () => {
            const key = isDeleted ? "notes.select.deleted" : "notes.select";
            const raw = results.get(key) ?? { data: null, error: null };
            const data = Array.isArray(raw.data)
              ? (raw.data[0] ?? null)
              : raw.data;
            return Promise.resolve({ data, error: raw.error });
          };
        }
        return (...callArgs: unknown[]) => {
          if (prop === "not" && callArgs[0] === "deleted_at") {
            isDeleted = true;
          }
          return new Proxy(chain, handler);
        };
      },
    };

    return new Proxy(chain, handler);
  }

  const storageSpy = vi.fn(
    async (bucket: string, path: string, ttl: number) => {
      const key = `storage.createSignedUrl.${bucket}.${path}`;
      const override = results.get(key);
      if (override) {
        if (
          override.data === null &&
          typeof override.error === "object" &&
          override.error !== null &&
          "__reject" in override.error
        ) {
          throw (override.error as { __reject: unknown }).__reject;
        }
        return override;
      }
      return {
        data: { signedUrl: `https://mock.example/${path}?ttl=${ttl}` },
        error: null,
      };
    },
  );

  function storageBucket(bucket: string) {
    return {
      createSignedUploadUrl: async (..._args: unknown[]) =>
        storageResults.get("createSignedUploadUrl") ?? {
          data: { signedUrl: "https://mock/upload" },
          error: null,
        },
      createSignedUrl: (path: string, ttl: number) =>
        storageSpy(bucket, path, ttl),
      remove: async (..._args: unknown[]) =>
        storageResults.get("remove") ?? { data: null, error: null },
      list: async (..._args: unknown[]) =>
        storageResults.get("list") ?? { data: [], error: null },
    };
  }

  async function rpc(name: string, _args?: unknown) {
    const key = `rpc.${name}`;
    return results.get(key) ?? { data: null, error: null };
  }

  const client = {
    from: (table: string) => ({
      insert: (..._args: unknown[]) => makeChain(table, "insert"),
      select: (...args: unknown[]) => {
        if (table === "notes") {
          return makeNotesSelectChain(args);
        }
        return selectChain(table, args);
      },
      update: (..._args: unknown[]) => makeChain(table, "update"),
      upsert: (...args: unknown[]) => {
        upsertCalls.push({ table, rows: args[0], opts: args[1] });
        return makeChain(table, "upsert");
      },
      delete: (..._args: unknown[]) => makeChain(table, "delete"),
    }),
    storage: { from: storageBucket },
    rpc,
    _results: results,
    _storage: storageResults,
    _storageSpy: storageSpy,
    _upsertCalls: upsertCalls,
  };

  return client as unknown as SupabaseClient & {
    _results: Map<string, { data: unknown; error: unknown }>;
    _storage: Map<string, { data: unknown; error: unknown }>;
    _storageSpy: typeof storageSpy;
    _upsertCalls: Array<{ table: string; rows: unknown; opts: unknown }>;
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
