<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolveReturnTo } from "$lib/auth/return-to";
  import OAuthButtons from "$lib/components/OAuthButtons.svelte";
  import AuthCard from "$lib/components/AuthCard.svelte";

  let { data } = $props();
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  // Validated /app-only destination, threaded into both the email login and
  // the OAuth round-trip. resolveReturnTo falls back to "/app".
  const returnTo = $derived(
    resolveReturnTo(page.url.searchParams.get("return_to")),
  );

  // Surface provider-error redirects from /auth/callback (?error=...).
  const callbackError = $derived(page.url.searchParams.get("error"));

  async function handleLogin(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    loading = true;
    error = "";
    const { error: err } = await data.supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (err) {
      error = err.message;
      loading = false;
    } else {
      goto(returnTo);
    }
  }
</script>

<AuthCard heading={null}>
  <h2>Log in to Librito</h2>

  {#if callbackError === "signup_disabled"}
    <p class="auth-msg">Librito isn't open for sign-ups yet.</p>
  {:else if callbackError}
    <p class="auth-error" role="alert">
      Sign-in was cancelled or failed. Try again.
    </p>
  {/if}

  <OAuthButtons supabase={data.supabase} {returnTo} />

  <div class="divider"><span>or</span></div>

  {#if error}
    <p class="auth-error" role="alert">{error}</p>
  {/if}

  <form onsubmit={handleLogin}>
    <label>
      Email
      <input type="email" bind:value={email} required />
    </label>
    <label>
      Password
      <input type="password" bind:value={password} required />
    </label>
    <button type="submit" class="primary" disabled={loading}>
      {loading ? "Logging in..." : "Log in"}
    </button>
  </form>

  <p class="footer">
    Don't have an account? <a href="/auth/signup">Sign up</a>
  </p>
</AuthCard>

<!-- Card/form/divider/button styling lives in AuthCard.svelte. Only the
     page heading is page-scoped here, per the app.css per-file heading
     convention. -->
<style>
  /* Auth-modal heading. The site header owns the page <h1> (Header.svelte),
     so this is an <h2>. Matches the webapp hero-heading recipe
     (cf. .book-detail-title in app.css): 24px @700, tight 1.2 leading;
     family + opsz + letter-spacing come from the global h1,h2 rule. */
  h2 {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
    color: #dedede;
  }
</style>
