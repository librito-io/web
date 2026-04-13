<script lang="ts">
  import { goto } from '$app/navigation';

  let { data } = $props();
  let email = $state('');
  let password = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleLogin(e: SubmitEvent) {
    e.preventDefault();
    loading = true;
    error = '';

    const { error: err } = await data.supabase.auth.signInWithPassword({ email, password });
    if (err) {
      error = err.message;
      loading = false;
    } else {
      goto('/app');
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
    {loading ? 'Logging in...' : 'Log in'}
  </button>
</form>

<p>Don't have an account? <a href="/auth/signup">Sign up</a></p>
