<script lang="ts">
  import { page } from "$app/stores";
  import { enhance } from "$app/forms";
  import { _ } from "$lib/i18n";
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
  <h1>{$_("authVerifyHeading")}</h1>

  {#if email}
    <!-- prefix/suffix split keeps the email <strong>-emphasized without piping
         attacker-controlled (?email=) input through {@html}. Translators carry
         verb-final word order (de/ja/ko) in the suffix. -->
    <p class="auth-msg">
      {$_("authVerifySentToPrefix")}<strong>{email}</strong>{$_(
        "authVerifySentToSuffix",
      )}
    </p>
  {:else}
    <p class="auth-msg">{$_("authVerifySentNoEmail")}</p>
  {/if}

  {#if form?.message}
    <p class="auth-error" role="alert">{form.message}</p>
  {/if}

  <form method="POST" use:enhance>
    <input type="hidden" name="email" value={email} />
    <label>
      {$_("authVerifyCodeLabel")}
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
      {$_("authVerifySubmit")}
    </button>
  </form>

  {#if resent}
    <p class="hint">{$_("authVerifyResent")}</p>
  {/if}
  {#if resendError}
    <p class="auth-error" role="alert">{resendError}</p>
  {/if}

  {#if email}
    <button class="secondary" onclick={handleResend} disabled={cooldown}>
      {cooldown ? $_("authVerifyResendCooldown") : $_("authVerifyResend")}
    </button>
  {/if}

  <p class="footer"><a href="/auth/login">{$_("authVerifyBackToLogin")}</a></p>
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
