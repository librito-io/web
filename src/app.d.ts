import type { SupabaseClient, Session, User } from "@supabase/supabase-js";
import type { SupportedLocale } from "$lib/i18n/locales";

declare module "*?raw" {
  const content: string;
  export default content;
}

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient;
      safeGetSession: () => Promise<{
        session: Session | null;
        user: User | null;
      }>;
      // Populated by appAuthGuard (hooks.server.ts) on /app/** routes
      // before any page load, form action, or +server.ts endpoint runs.
      // Null on anonymous routes (`/`, `/auth/*`). Callers under /app/**
      // must narrow via `requireUser(event)` — never read .user directly,
      // and never rely on the `!` operator. Issue #348.
      session: Session | null;
      user: User | null;
      requestId: string;
      // Resolved by localeSetup (hooks.server.ts): locale cookie →
      // Accept-Language → "en". Drives SSR i18n init and the <html>
      // lang/dir rewrite. Issue #523.
      locale: SupportedLocale;
    }
    interface PageData {
      session?: Session | null;
      user?: User | null;
      supabase?: SupabaseClient;
    }
  }
}

export {};
