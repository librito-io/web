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
    }
    interface PageData {
      session?: Session | null;
      user?: User | null;
      supabase?: SupabaseClient;
    }
  }
}

export {};
