<script lang="ts">
  import { page } from "$app/stores";

  let { data } = $props();

  const email = $derived($page.url.searchParams.get("email") ?? "");

  let resent = $state(false);
  let resendError = $state("");
  let cooldown = $state(false);

  async function handleResend() {
    if (cooldown || !email) return;
    resent = false;
    resendError = "";

    const { error } = await data.supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      resendError = error.message;
    } else {
      resent = true;
      cooldown = true;
      setTimeout(() => {
        cooldown = false;
      }, 60000);
    }
  }
</script>

<div
  class="content"
  style="max-width: 480px; margin: 80px auto; text-align: center;"
>
  <h1 style="color: #e8e8e8; font-size: 1.5rem; margin-bottom: 16px;">
    Check your email
  </h1>

  {#if email}
    <p
      style="color: #ccc; font-size: 1rem; line-height: 1.6; margin-bottom: 32px;"
    >
      We sent a confirmation link to <strong style="color: #e8e8e8;"
        >{email}</strong
      >. Click the link to activate your account.
    </p>
  {:else}
    <p
      style="color: #ccc; font-size: 1rem; line-height: 1.6; margin-bottom: 32px;"
    >
      We sent a confirmation link to your email address. Click the link to
      activate your account.
    </p>
  {/if}

  {#if resent}
    <p style="color: #888; font-size: 0.9rem; margin-bottom: 16px;">
      Confirmation resent.
    </p>
  {/if}

  {#if resendError}
    <p style="color: #c44; font-size: 0.9rem; margin-bottom: 16px;">
      {resendError}
    </p>
  {/if}

  {#if email}
    <button
      onclick={handleResend}
      disabled={cooldown}
      style="background: #2a2a2a; color: #e8e8e8; border: 1px solid #3a3a3a; border-radius: 999px; padding: 10px 24px; font-size: 0.95rem; cursor: pointer; margin-bottom: 24px; opacity: {cooldown
        ? '0.5'
        : '1'};"
    >
      {cooldown ? "Resend (wait 60s)" : "Resend confirmation"}
    </button>
  {/if}

  <p style="color: #888; font-size: 0.9rem;">
    <a href="/auth/login" style="color: #888; text-decoration: underline;"
      >Back to login</a
    >
  </p>
</div>
