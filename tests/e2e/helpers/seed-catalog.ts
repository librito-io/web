// E2E fixture seeder for the six catalog acceptance fixtures (spec
// "Testing → Test fixtures"). Two pieces:
//
//   - FIXTURES — static metadata for the six books; consumed directly by
//     specs for getByText assertions ("title", "author") plus
//     `book_hash` seeding via the admin client.
//   - seedFixture(name) — resolves the fixture against the catalog
//     resolver so `book_catalog` carries cover + description before the
//     spec navigates to /app/feed.
//
// The resolver call is gated on cassette tooling shipping (issue #431);
// without recorded HTTP responses the seeder would hit live OL / GB /
// iTunes upstreams on every CI build, which the suite explicitly
// rejects via `test.skip(!process.env.CATALOG_E2E_NETWORK, ...)` in the
// network-bound specs.
//
// PR5 ships the FIXTURES table + a `seedFixture` stub that throws a
// clear "implement under #431" message when invoked. Admin specs do NOT
// import seedFixture — they insert catalog rows directly via getAdmin()
// for the table state each action exercises. Only feed-renders-six and
// book-detail-renders-metadata depend on seedFixture, and both already
// `test.skip` when the env gate is absent.

export interface Fixture {
  title: string;
  author: string;
  isbn?: string;
}

export const FIXTURES = {
  "thinking-machine": {
    title: "The Thinking Machine",
    author: "Stephen Witt",
    isbn: "9780593832691",
  },
  "are-you-mad": {
    title: "Are You Mad at Me?",
    author: "Meg Josephson",
    isbn: "9781668082461",
  },
  "crying-in-h-mart": {
    title: "Crying in H Mart",
    author: "Michelle Zauner",
    isbn: "9780525657743",
  },
  "ruth-ta": { title: "Ruth", author: "Kate Riley" },
  "1984-ta": { title: "1984", author: "George Orwell" },
  "the-compound": {
    title: "The Compound",
    author: "Aisling Rawle",
    isbn: "9780593977279",
  },
} as const satisfies Record<string, Fixture>;

export type FixtureKey = keyof typeof FIXTURES;

/**
 * Drives the catalog resolver against the named fixture so a follow-up
 * navigation to /app/feed or /app/book/<hash> finds cover + description
 * in `book_catalog`.
 *
 * NOT IMPLEMENTED in PR5 — depends on cassette tooling tracked in
 * issue #431. Network-bound specs guard with `test.skip(!process.env
 * .CATALOG_E2E_NETWORK, "Requires cassette tooling or live network")`,
 * so this stub never fires on default CI. When invoked under the env
 * gate it throws so the operator notices the missing wiring instead of
 * silently producing empty fixtures.
 */
export async function seedFixture(_name: FixtureKey): Promise<void> {
  throw new Error(
    "seedFixture not implemented — cassette tooling tracked in librito-io/web#431. " +
      "Specs that depend on it gate via CATALOG_E2E_NETWORK; PR5 ships the FIXTURES " +
      "table + spec scaffolding only.",
  );
}
