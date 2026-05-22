<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolveReturnTo } from "$lib/auth/return-to";

  let { data } = $props();
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

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
      // appAuthGuard hook (hooks.server.ts) encodes the intended URL
      // into ?return_to= when redirecting unauthenticated GETs to
      // /auth/login. Validate against an allow-list (same-origin /app/*
      // paths only) so a forged ?return_to=//evil.com or
      // ?return_to=https://attacker.com cannot turn login into an
      // open-redirect oracle. Issue #349.
      goto(resolveReturnTo(page.url.searchParams.get("return_to")));
    }
  }
</script>

<h1>Log in</h1>

{#if error}
  <p style="color: red;">{error}</p>
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
  <button type="submit" disabled={loading}>
    {loading ? "Logging in..." : "Log in"}
  </button>
</form>

<p>Don't have an account? <a href="/auth/signup">Sign up</a></p>
