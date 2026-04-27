// tests/fixtures/dev-jwk.ts
//
// Self-contained synthetic ES256 JWK for unit tests. Hardcoded literal;
// NOT loaded from disk, NOT connected to local Supabase, NOT used in any
// deployment. Tests round-trip this JWK through mintRealtimeToken /
// jose.importJWK and verify the resulting JWT — opaque data, not a
// credential.
//
// Decoupled from supabase/signing_keys.json (gitignored, per-developer)
// so vitest passes on CI without any Supabase setup.
//
// To regenerate (rarely needed; the fixture is intentionally stable):
//   supabase gen signing-key --algorithm ES256
// then paste the output JSON below, replacing key_ops with ["verify"]
// (matches the standby-key shape on the wire) and changing kid to a
// fixture-recognizable string.

export const DEV_STANDBY_JWK = {
  kty: "EC",
  kid: "fixture-standby-do-not-use",
  use: "sig",
  key_ops: ["verify"],
  alg: "ES256",
  ext: true,
  d: "aH-L2vmlXJxyc3_f_xLjS0LnrnzD5egYcnhObpri0yE",
  crv: "P-256",
  x: "QCAfNXtkt-ZQYxXp1vRFLXq-n96Tu7W93K5-jFioY9U",
  y: "hJRZ07gNc5Okj9OGce6IEacml4bQPon6JuJn-dr5VCM",
} as const;

export const DEV_STANDBY_JWK_STR = JSON.stringify(DEV_STANDBY_JWK);
export const DEV_KID = DEV_STANDBY_JWK.kid;
