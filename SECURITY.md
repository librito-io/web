# Security policy

## Reporting a vulnerability

**Do not file a public issue for security problems.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability →](https://github.com/librito-io/web/security/advisories/new)**

This sends a private report visible only to maintainers. We aim to respond within 7 days.

## Scope

- Authentication, session, and pairing flows
- Device API token handling
- Database access patterns and RLS policy gaps
- Cross-user data leakage
- Cryptographic primitives (signing keys, hashing)

## Out of scope

- Reports requiring physical access to a paired device
- DoS via expected rate limits (publish responsibly via GitHub advisories if you find a bypass)
- Issues in third-party services we depend on (Supabase, Vercel, Upstash) — report to them directly
