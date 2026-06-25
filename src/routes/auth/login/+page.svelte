<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { _ } from "$lib/i18n";
  import { resolveReturnTo } from "$lib/auth/return-to";
  import OAuthButtons from "$lib/components/OAuthButtons.svelte";
  import AuthCard from "$lib/components/AuthCard.svelte";
  import PasswordInput from "$lib/components/PasswordInput.svelte";

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
  <h2>{$_("authLoginHeading")}</h2>

  {#if callbackError === "signup_disabled"}
    <p class="auth-msg">{$_("authSignupDisabled")}</p>
  {:else if callbackError}
    <p class="auth-error" role="alert">
      {$_("authOAuthCancelled")}
    </p>
  {/if}

  <OAuthButtons supabase={data.supabase} {returnTo} />

  <div class="divider"><span>{$_("authOr")}</span></div>

  {#if error}
    <p class="auth-error" role="alert">{error}</p>
  {/if}

  <form onsubmit={handleLogin}>
    <label>
      {$_("authEmail")}
      <input type="email" bind:value={email} required />
    </label>
    <PasswordInput
      label={$_("authPassword")}
      bind:value={password}
      autocomplete="current-password"
      required
    />
    <button type="submit" class="primary" disabled={loading}>
      {loading ? $_("authLoginSubmitLoading") : $_("authLoginSubmit")}
    </button>
  </form>

  <p class="footer">
    {$_("authLoginFooterPrompt")}
    <a href="/auth/signup">{$_("authSignupLink")}</a>
  </p>
</AuthCard>

<!-- Card/form/divider/button styling lives in AuthCard.svelte. Only the
     page heading is page-scoped here, per the app.css per-file heading
     convention. -->
<style>
  /* Auth-modal heading. The site header owns the page <h1> (Header.svelte),
     so this is an <h2>. 28px = the 2xl scale token (see docs/dev/style-guide.md
     §2.1); 700 weight, tight 1.2 leading; family + opsz + letter-spacing come
     from the global h1,h2 rule. */
  h2 {
    font-size: 1.75rem;
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
    color: #dedede;
    /* 24px + the card's 24px flex gap = 48px below the heading. */
    margin-bottom: 24px;
  }
</style>
