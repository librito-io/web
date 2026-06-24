<script lang="ts">
  import { page } from "$app/stores";
  import { enhance } from "$app/forms";
  import AuthCard from "$lib/components/AuthCard.svelte";

  let { data, form } = $props();

  const email = $derived($page.url.searchParams.get("email") ?? "");

  let code = $state("");
  let resent = $state(false);
  let resendError = $state("");
  let cooldown = $state(false);
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    return () => {
      if (cooldownTimer) clearTimeout(cooldownTimer);
    };
  });

  async function handleResend(): Promise<void> {
    if (cooldown || !email) return;
    resent = false;
    resendError = "";
    // resend reuses the confirmation.html template, which now renders the OTP
    // code (Task 6) — no template switch needed.
    const { error } = await data.supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      resendError = error.message;
    } else {
      resent = true;
      cooldown = true;
      cooldownTimer = setTimeout(() => {
        cooldown = false;
      }, 60000);
    }
  }
</script>

<AuthCard>
  <h1>Check your email</h1>

  {#if email}
    <p class="auth-msg">
      We sent a 6-digit code to <strong>{email}</strong>. Enter it below to
      activate your account.
    </p>
  {:else}
    <p class="auth-msg">We sent a 6-digit code to your email address.</p>
  {/if}

  {#if form?.message}
    <p class="auth-error" role="alert">{form.message}</p>
  {/if}

  <form method="POST" use:enhance>
    <input type="hidden" name="email" value={email} />
    <label>
      6-digit code
      <input
        name="token"
        bind:value={code}
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]*"
        maxlength="6"
        required
      />
    </label>
    <button type="submit" class="primary" disabled={code.length !== 6}>
      Verify
    </button>
  </form>

  {#if resent}
    <p class="hint">Code resent.</p>
  {/if}
  {#if resendError}
    <p class="auth-error" role="alert">{resendError}</p>
  {/if}

  {#if email}
    <button class="secondary" onclick={handleResend} disabled={cooldown}>
      {cooldown ? "Resend (wait 60s)" : "Resend code"}
    </button>
  {/if}

  <p class="footer"><a href="/auth/login">Back to login</a></p>
</AuthCard>

<style>
  /* Page-specific only: the OTP code input (centered, spaced) and the
     emphasized email in the message. All shared card/form/button/error/footer
     styling comes from AuthCard.svelte (Task 2). The class names used above
     (.auth-msg, .auth-error, .hint, .footer, .primary, .secondary, h1) are
     defined globally-scoped under .auth-card in AuthCard. */
  input[name="token"] {
    font-size: 1.25rem;
    letter-spacing: 0.3em;
    text-align: center;
  }
  .auth-msg strong {
    color: #e8e8e8;
  }
</style>
