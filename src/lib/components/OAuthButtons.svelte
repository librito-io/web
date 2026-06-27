<script lang="ts">
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { get } from "svelte/store";
  import { _ } from "$lib/i18n";
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
      // Click handler only fires client-side, so the i18n store is loaded;
      // get(_) is the script-context equivalent of {$_(...)} in markup.
      error = e instanceof Error ? e.message : get(_)("authOAuthFailed");
      pending = null;
    }
  }
</script>

<div class="oauth-buttons">
  {#if error}
    <p class="oauth-error" role="alert">{error}</p>
  {/if}

  <!-- Compact side-by-side provider buttons (Cloudflare-style): official logo
       + short label, centred as a pair. Short labels fit the half-width row;
       the full "Sign in with …" wording does not, and Cloudflare's own
       multi-provider row sets the precedent for the short form.
       Logos are the official brand assets — DO NOT recolor or resize (#559):
       - Google "G" keeps its four brand colors on any background (hardcoded).
       - Apple mark inherits the label color via currentColor, matching Apple's
         "logo color tracks text color" rule on a dark button.
       Google: https://developers.google.com/identity/branding-guidelines
       Apple:  https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple -->
  <div class="oauth-row">
    <button
      type="button"
      class="oauth-btn oauth-google"
      disabled={pending !== null}
      onclick={() => signIn("google")}
    >
      <svg
        class="oauth-logo"
        viewBox="0 0 18 18"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="#4285F4"
          d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.859-3.048.859-2.344 0-4.328-1.583-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z"
        />
        <path
          fill="#FBBC05"
          d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.321 0 2.508.454 3.44 1.346l2.582-2.581C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        />
      </svg>
      <span>Google</span>
    </button>

    <button
      type="button"
      class="oauth-btn oauth-apple"
      disabled={pending !== null}
      onclick={() => signIn("apple")}
    >
      <svg
        class="oauth-logo"
        viewBox="2.2 0 19.6 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"
        />
      </svg>
      <span>Apple</span>
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
    /* Logo hugs its label as a pair (Cloudflare row), not spread edge-to-edge. */
    gap: 8px;
    min-height: 48px; /* matches the email input + Log in button (≥ HIG 44px) */
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color var(--dur-2) var(--ease-hover),
      border-color var(--dur-2) var(--ease-hover);
  }
  .oauth-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  /* One step up the surface ladder (#0F1114 → #16181B → #1D1F22): a flat lift
     of the same cool-gray hue, still below the resting border. Border tracks
     the fill so the surface stays edgeless. :not(:disabled) keeps a button
     mid-OAuth from lighting up. */
  /* Guard hover behind a real pointer — on touch :hover latches after a tap
     (sticky-hover / flash). */
  @media (hover: hover) and (pointer: fine) {
    .oauth-btn:not(:disabled):hover {
      background: #1d1f22;
      border-color: #1d1f22;
    }
  }
  /* Brand logos track the label font-size (1em = 16px) so the G and the Apple
     mark read at one consistent size across the row — the standard
     multi-provider treatment (Cloudflare/Auth0). Within both brands' tolerances:
     Google mandates only no-recolor / no-distort / clear-space / min-size, and
     Apple's cap-height convention sits just under this. flex:none so the row
     never squeezes them off-spec (#559). */
  .oauth-logo {
    flex: none;
    /* Size by height; width follows the glyph's own aspect so a non-square mark
       (Apple) doesn't carry empty box padding into the logo↔label gap. */
    height: 1em;
    width: auto;
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
    font-size: 0.875rem;
    margin: 0 0 4px;
  }
</style>
