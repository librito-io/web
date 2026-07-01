-- Newsletter signups captured from the public site footer. Service-role-only:
-- the browser never touches this table directly — the /api/newsletter handler
-- writes via the admin (service_role) client. Email is normalized to lowercase
-- app-side before insert, so a plain UNIQUE(email) suffices (no citext).
create table public.newsletter_signups (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  locale     text,
  created_at timestamptz not null default now()
);

comment on table public.newsletter_signups is
  'Public marketing newsletter signups. Write path: POST /api/newsletter (service_role). Email lowercased app-side.';

-- RLS on, with NO anon/authenticated policies: PostgREST denies both roles;
-- service_role bypasses RLS. This keeps the list unreadable/unwritable from
-- the browser entirely.
alter table public.newsletter_signups enable row level security;
