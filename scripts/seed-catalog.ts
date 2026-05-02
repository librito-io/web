// scripts/seed-catalog.ts
/* eslint-disable no-console */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { canonicalizeIsbn } from "../src/lib/server/catalog/isbn";
import { resolveIsbn } from "../src/lib/server/catalog/fetcher";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
} from "../src/lib/server/ratelimit";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const supabase = createClient(
  env("PUBLIC_SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { autoRefreshToken: false, persistSession: false },
  },
);

async function main() {
  const path = resolve(process.cwd(), "scripts/data/seed-isbns.json");
  const list = JSON.parse(readFileSync(path, "utf8")) as string[];
  const canonical = list
    .map((s) => canonicalizeIsbn(s))
    .filter((s): s is string => !!s);
  const unique = [...new Set(canonical)];
  console.log(`seeding ${unique.length} unique canonical ISBNs`);

  let cached = 0,
    fresh = 0,
    paused = 0,
    errors = 0;
  for (const isbn of unique) {
    try {
      const r = await resolveIsbn(supabase, isbn, {
        rateLimiters: {
          openLibrary: catalogOpenLibraryLimiter,
          googleBooks: catalogGoogleBooksLimiter,
        },
      });
      if (r.cached) cached += 1;
      else fresh += 1;
      if (r.rateLimited) {
        paused += 1;
        // Pause 30s, let the sliding window drain.
        await new Promise((res) => setTimeout(res, 30_000));
      }
    } catch (err) {
      errors += 1;
      console.warn("seed-catalog: resolve failed", isbn, String(err));
    }
  }
  console.log(JSON.stringify({ done: true, cached, fresh, paused, errors }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
