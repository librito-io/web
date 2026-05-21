# Local dev setup — Realtime signing key

Tests run on CI without any Supabase setup (the fixture in `tests/fixtures/dev-jwk.ts` is self-contained). But the **manual local Realtime smoke test** — minting a token from `/api/realtime-token` and joining a Phoenix channel against local Supabase — requires that local gotrue and our minter share a signing key.

One-time bootstrap on each dev machine:

1. Generate two ES256 keys (one current, one standby):

   ```bash
   supabase gen signing-key --algorithm ES256
   supabase gen signing-key --algorithm ES256
   ```

   `supabase gen signing-key --append` prints to stdout but does NOT write the file (CLI v2.90 behavior). Capture both stdout outputs by hand.

2. Create `supabase/signing_keys.json` (gitignored) as a JSON array. Mark one key as current, the other as standby. Local gotrue (≥ v2.188) refuses more than one key with `key_ops: ["sign"]`, so the standby gets `key_ops: ["verify"]` only:

   ```json
   [
     {
       "kty": "EC",
       "kid": "<uuid-1>",
       "use": "sig",
       "key_ops": ["sign", "verify"],
       "alg": "ES256",
       "ext": true,
       "d": "...",
       "crv": "P-256",
       "x": "...",
       "y": "..."
     },
     {
       "kty": "EC",
       "kid": "<uuid-2>",
       "use": "sig",
       "key_ops": ["verify"],
       "alg": "ES256",
       "ext": true,
       "d": "...",
       "crv": "P-256",
       "x": "...",
       "y": "..."
     }
   ]
   ```

3. In `supabase/config.toml`, uncomment the `signing_keys_path` line under `[auth]`:

   ```toml
   [auth]
   signing_keys_path = "./signing_keys.json"
   ```

   This is a per-dev local modification — do NOT commit. The committed form keeps the line commented to match the upstream Supabase CLI template default; CI, fresh clones, and self-hosters need it that way so `supabase start` doesn't error on a missing key file. The Supabase CLI does not support `env(...)` substitution for `signing_keys_path` ([`pkg/config/auth.go:163`](https://github.com/supabase/cli/blob/v2.90.0/pkg/config/auth.go#L163) declares it as a plain `string`, not the `Secret` wrapper type), so there is no committed form that works for everyone — the line must stay commented in version control.

   To prevent the local edit from following you into accidental commits, mark the file as locally modified:

   ```bash
   git update-index --skip-worktree supabase/config.toml
   ```

   Undo when you need to pull a real upstream change to this file:

   ```bash
   git update-index --no-skip-worktree supabase/config.toml
   git pull
   # re-apply the uncomment, then re-skip:
   git update-index --skip-worktree supabase/config.toml
   ```

4. Set `LIBRITO_JWT_PRIVATE_KEY_JWK` in your `.env` to the **standby** key's full JWK as a single-line JSON string (include the `d` field — the minter signs with it).

5. Restart Supabase: `supabase stop && supabase start`.

6. Confirm both `kid`s appear at `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`.

Production keys are managed entirely through Supabase Dashboard → Project Settings → JWT signing keys → "new standby key", and `LIBRITO_JWT_PRIVATE_KEY_JWK` in Vercel Production env. Production keys never touch a developer's disk.
