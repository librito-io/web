import type { SupabaseClient, Session, User } from "@supabase/supabase-js";

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
    }
    interface PageData {
      session?: Session | null;
      user?: User | null;
      supabase?: SupabaseClient;
    }
  }
}

export {};
