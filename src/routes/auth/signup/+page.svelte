<script lang="ts">
  import { goto } from "$app/navigation";
  import { env } from "$env/dynamic/public";
  import { _ } from "$lib/i18n";
  import OAuthButtons from "$lib/components/OAuthButtons.svelte";
  import AuthCard from "$lib/components/AuthCard.svelte";
  import PasswordInput from "$lib/components/PasswordInput.svelte";

  let { data } = $props();
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  // Cosmetic pre-launch gate; GoTrue enable_signup is the real enforcement.
  const launched = env.PUBLIC_LAUNCHED === "true";

  // New signups always land in /app post-onboarding; no deep-link return_to on
  // the signup path (a brand-new user has nowhere to deep-link back to).
  const returnTo = "/app";

  async function handleSignup(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    loading = true;
    error = "";
    const { error: err } = await data.supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (err) {
      error = err.message;
      loading = false;
    } else {
      goto(`/auth/verify-email?email=${encodeURIComponent(email)}`);
    }
  }
</script>

<AuthCard heading={null}>
  <h2>{$_("authSignupHeading")}</h2>

  {#if launched}
    <OAuthButtons supabase={data.supabase} {returnTo} />

    <div class="divider"><span>{$_("authOr")}</span></div>

    {#if error}
      <p class="auth-error" role="alert">{error}</p>
    {/if}

    <form onsubmit={handleSignup}>
      <label>
        {$_("authEmail")}
        <input
          type="email"
          name="email"
          autocomplete="email"
          bind:value={email}
          required
        />
      </label>
      <PasswordInput
        label={$_("authPassword")}
        bind:value={password}
        autocomplete="new-password"
        minlength={6}
        required
      />
      <button type="submit" class="primary" disabled={loading}>
        {loading ? $_("authSignupSubmitLoading") : $_("authSignupSubmit")}
      </button>
    </form>
  {:else}
    <p class="auth-msg">{$_("authSignupNotLaunched")}</p>
  {/if}

  <p class="footer">
    {$_("authSignupFooterPrompt")}
    <a href="/auth/login">{$_("authLoginLink")}</a>
  </p>
</AuthCard>

<!-- Card/form/divider/button styling lives in AuthCard.svelte. Only the
     page heading is page-scoped here (matches login), per the app.css
     per-file heading convention. -->
<style>
  /* Auth-modal heading — <h2> because the site header owns the page <h1>.
     Matches login: 28px = the 2xl scale token (docs/dev/style-guide.md §2.1),
     700 weight, 1.2 leading; family/opsz/tracking from the global h1,h2 rule. */
  h2 {
    font-size: 1.75rem;
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
    color: #dedede;
    /* 24px + the card's 24px flex gap = 48px below the heading. */
    margin-bottom: 24px;
  }
  /* Mobile: centre the heading in the band between the header divider and the
     content below it (OAuth buttons post-launch, the not-launched message
     pre-launch — both sit at the same Y, driven by the h2 margin chain). The
     -16/+40 margins sum to the original 24px so nothing below moves; mirrors
     login so the two screens match. */
  @media (max-width: 480px) {
    h2 {
      margin-top: -16px;
      margin-bottom: 40px;
    }
  }
</style>
