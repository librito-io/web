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

  <!-- ToS-mandated styling. Wording + colors are fixed by Google/Apple brand
       guidelines. Paste the OFFICIAL logo SVGs in the marked slots from:
       Google:  https://developers.google.com/identity/branding-guidelines
       Apple:   https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
       Do not recolor or resize the logos. -->
  <button
    type="button"
    class="oauth-btn oauth-google"
    disabled={pending !== null}
    onclick={() => signIn("google")}
  >
    <!-- OFFICIAL GOOGLE "G" SVG HERE -->
    <span>{pending === "google" ? "Connecting…" : "Continue with Google"}</span>
  </button>

  <button
    type="button"
    class="oauth-btn oauth-apple"
    disabled={pending !== null}
    onclick={() => signIn("apple")}
  >
    <!-- OFFICIAL APPLE LOGO SVG HERE -->
    <span>{pending === "apple" ? "Connecting…" : "Continue with Apple"}</span>
  </button>
</div>

<style>
  .oauth-buttons {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .oauth-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    min-height: 44px; /* Apple HIG minimum touch target */
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
  }
  .oauth-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  /* Google: white bg, #3c4043 text, #dadce0 border (brand spec). */
  .oauth-google {
    background: #ffffff;
    color: #3c4043;
    border: 1px solid #dadce0;
  }
  /* Apple: black bg, white text (brand spec). */
  .oauth-apple {
    background: #000000;
    color: #ffffff;
    border: 1px solid #000000;
  }
  .oauth-error {
    color: #c44;
    font-size: 0.9rem;
    margin: 0 0 4px;
  }
</style>
