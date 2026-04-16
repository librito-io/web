<script lang="ts">
  import { goto } from "$app/navigation";

  let { data } = $props();
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

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

<p>Already have an account? <a href="/auth/login">Log in</a></p>
