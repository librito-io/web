<script lang="ts">
  import { goto } from "$app/navigation";
  import { env } from "$env/dynamic/public";

  let { data } = $props();
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  // Cosmetic pre-launch gate. The real enforcement is Supabase's
  // enable_signup flag — GoTrue rejects signUp() with "Signups not allowed
  // for this instance" regardless of this value. PUBLIC_LAUNCHED only swaps
  // the form for a friendly notice so a visitor never hits that raw error.
  // Flip to "true" at launch (see .env.example). $env/dynamic/public so an
  // unset value reads "" (pre-launch) instead of a build error.
  const launched = env.PUBLIC_LAUNCHED === "true";

  async function handleSignup(e: SubmitEvent) {
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

<h1>Sign up</h1>

{#if launched}
  {#if error}
    <p style="color: red;">{error}</p>
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
    <button type="submit" disabled={loading}>
      {loading ? "Signing up..." : "Sign up"}
    </button>
  </form>
{:else}
  <p>
    Librito isn't open for sign-ups yet — we're putting on the finishing
    touches.
  </p>
{/if}

<p>Already have an account? <a href="/auth/login">Log in</a></p>
