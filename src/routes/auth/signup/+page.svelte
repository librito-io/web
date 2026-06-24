<script lang="ts">
  import { goto } from "$app/navigation";
  import { env } from "$env/dynamic/public";
  import OAuthButtons from "$lib/components/OAuthButtons.svelte";
  import AuthCard from "$lib/components/AuthCard.svelte";

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
  <h2>Sign up to Librito</h2>

  {#if launched}
    <OAuthButtons supabase={data.supabase} {returnTo} />

    <div class="divider"><span>or</span></div>

    {#if error}
      <p class="auth-error" role="alert">{error}</p>
    {/if}

    <form onsubmit={handleSignup}>
      <label>
        Email
        <input type="email" bind:value={email} required />
      </label>
      <label>
        Password
        <input type="password" bind:value={password} minlength="6" required />
      </label>
      <button type="submit" class="primary" disabled={loading}>
        {loading ? "Signing up..." : "Sign up"}
      </button>
    </form>
  {:else}
    <p class="auth-msg">
      Librito isn't open for sign-ups yet — we're putting on the finishing
      touches.
    </p>
  {/if}

  <p class="footer">
    Already have an account? <a href="/auth/login">Log in</a>
  </p>
</AuthCard>

<!-- Card/form/divider/button styling lives in AuthCard.svelte. Only the
     page heading is page-scoped here (matches login), per the app.css
     per-file heading convention. -->
<style>
  /* Auth-modal heading — <h2> because the site header owns the page <h1>.
     Matches login + the webapp hero recipe (.book-detail-title): 24px @700,
     1.2 leading; family/opsz/tracking from the global h1,h2 rule. */
  h2 {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
    color: #dedede;
  }
</style>
