<script lang="ts">
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { buildOAuthRedirectTo } from "$lib/auth/oauth";

  let { supabase, returnTo }: { supabase: SupabaseClient; returnTo: string } =
    $props();

  let pending = $state<"google" | "apple" | null>(null);
  let error = $state("");

  async function signIn(provider: "google" | "apple"): Promise<void> {
    pending = provider;
    error = "";
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: buildOAuthRedirectTo(window.location.origin, returnTo),
        },
      });
      // Happy path redirects the tab and resolves with error: null. A non-null
      // error means no navigation happened (bad config / network) — surface it.
      if (err) {
        error = err.message;
        pending = null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Sign-in failed. Try again.";
      pending = null;
    }
  }
</script>

<div class="oauth-buttons">
  {#if error}
    <p class="oauth-error" role="alert">{error}</p>
  {/if}

  <!-- Compact side-by-side provider buttons (Cloudflare-style). Short labels
       fit the half-width layout; the OFFICIAL logos + brand-compliant final
       wording are finalized in the #559 brand pass. Paste official logo SVGs
       in the marked slots:
       Google: https://developers.google.com/identity/branding-guidelines
       Apple:  https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple -->
  <div class="oauth-row">
    <button
      type="button"
      class="oauth-btn oauth-google"
      disabled={pending !== null}
      onclick={() => signIn("google")}
    >
      <!-- OFFICIAL GOOGLE "G" SVG HERE -->
      <span>{pending === "google" ? "Connecting…" : "Google"}</span>
    </button>

    <button
      type="button"
      class="oauth-btn oauth-apple"
      disabled={pending !== null}
      onclick={() => signIn("apple")}
    >
      <!-- OFFICIAL APPLE LOGO SVG HERE -->
      <span>{pending === "apple" ? "Connecting…" : "Apple"}</span>
    </button>
  </div>
</div>

<style>
  .oauth-buttons {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .oauth-row {
    display: flex;
    gap: 12px;
  }
  .oauth-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 48px; /* matches the email input + Log in button (≥ HIG 44px) */
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
  }
  .oauth-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .oauth-google {
    background: #16181b;
    color: #dedede;
    border: 1px solid #16181b;
  }
  .oauth-apple {
    background: #16181b;
    color: #dedede;
    border: 1px solid #16181b;
  }
  .oauth-error {
    color: #c44;
    font-size: 0.9rem;
    margin: 0 0 4px;
  }
</style>
