<script lang="ts">
  import { _ } from "$lib/i18n";
  import { enhance } from "$app/forms";

  type ActionResult = { ok?: boolean; error?: string } | null;
  let { form }: { form: ActionResult } = $props();

  let submitting = $state(false);
</script>

<svelte:head>
  <title>Help · Librito</title>
</svelte:head>

<section class="help">
  {#if form?.ok}
    <div class="sent" role="status">
      <svg
        class="sent-check"
        width="52"
        height="52"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#007DE8"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12l3 3 5-6" />
      </svg>
      <h1>{$_("helpSentHeading")}</h1>
      <p class="sent-body">{$_("helpFormSuccess")}</p>
      <a class="sent-home" href="/">{$_("helpSentHome")}</a>
    </div>
  {:else}
    <h1>{$_("helpHeading")}</h1>
    <form
      method="POST"
      action="?/contact"
      use:enhance={() => {
        submitting = true;
        return async ({ update }) => {
          await update();
          submitting = false;
        };
      }}
    >
      <!-- Honeypot: hidden from humans, tempting to bots. Server drops any
           submission where this is non-empty. -->
      <input
        class="hp"
        type="text"
        name="company"
        tabindex="-1"
        autocomplete="off"
        aria-hidden="true"
      />

      <label for="help-reason">{$_("helpFormReason")}</label>
      <select id="help-reason" name="reason">
        <option value="bug">{$_("helpFormReasonBug")}</option>
        <option value="feature">{$_("helpFormReasonFeature")}</option>
        <option value="other">{$_("helpFormReasonOther")}</option>
      </select>

      <label for="help-name">{$_("helpFormName")}</label>
      <input id="help-name" name="name" type="text" required />

      <label for="help-email">{$_("helpFormEmail")}</label>
      <input id="help-email" name="email" type="email" required />

      <label for="help-message">{$_("helpFormMessage")}</label>
      <textarea id="help-message" name="message" rows="6" required></textarea>

      {#if form?.error}
        <p class="error" role="alert">{form.error}</p>
      {/if}

      <button type="submit" disabled={submitting}>
        {submitting ? $_("helpFormSending") : $_("helpFormSubmit")}
      </button>
    </form>
  {/if}
</section>

<style>
  .help {
    max-width: 42rem;
    margin: 3rem auto;
    padding: 0 1.25rem;
  }
  h1 {
    font-size: 2rem;
    margin-bottom: 48px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  label {
    font-weight: 600;
  }
  input[type="text"],
  input[type="email"],
  select,
  textarea {
    background: #16181b;
    border: none;
    border-radius: 8px;
    color: #ededed;
    padding: 0.65rem 1rem;
    font: inherit;
  }
  /* Drop the native OS arrow (unpositionable, floats at the field edge) and
     draw a custom chevron pinned to the right. */
  select {
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    padding-right: 2.25rem;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%239a9a9a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.9rem center;
    background-size: 1.1rem;
  }
  /* No focus ring — removed by request (trades off the WCAG 2.4.7 visible-
     focus affordance for keyboard users). */
  input[type="text"]:focus,
  input[type="email"]:focus,
  select:focus,
  textarea:focus {
    outline: none;
  }
  /* Chrome/Safari autofill paints a white/yellow background over the field.
     The inset-shadow trick repaints it with our own background; text-fill
     keeps the value light. Uses box-shadow (not background) so it never
     fights the outline-based focus ring above. */
  input[type="text"]:-webkit-autofill,
  input[type="text"]:-webkit-autofill:hover,
  input[type="text"]:-webkit-autofill:focus,
  input[type="email"]:-webkit-autofill,
  input[type="email"]:-webkit-autofill:hover,
  input[type="email"]:-webkit-autofill:focus {
    -webkit-box-shadow: 0 0 0 1000px #16181b inset;
    -webkit-text-fill-color: #ededed;
    caret-color: #ededed;
    transition: background-color 9999s ease-in-out 0s;
  }
  /* Honeypot: removed from the visual + a11y tree, still in the DOM for bots. */
  .hp {
    position: absolute;
    left: -9999px;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  button {
    margin-top: 2rem;
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    height: 48px;
    background: #dedede;
    color: #15171a;
    border: none;
    border-radius: 999px;
    padding: 0 1.75rem;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    /* Same "lift toward light" as the header Log in + landing Get started
       CTAs (#dedede → #fff). */
    transition: background-color var(--dur-2) var(--ease-hover);
  }
  /* Guard hover behind a real pointer — on touch, :hover latches after a tap
     (sticky-hover), matching the .login-link pattern in app.css. */
  @media (hover: hover) and (pointer: fine) {
    button:hover:not(:disabled) {
      background: #fff;
    }
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .sent {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 1.5rem;
    padding: 32px 0 16px;
  }
  .sent-check {
    margin-bottom: 0;
  }
  .sent h1 {
    /* Extra breathing room below the heading only; stacks on the flex gap.
       (Overrides the form h1's 48px bottom gap.) */
    margin-bottom: 0.75rem;
  }
  .sent-body {
    color: #dedede;
    font-size: 1.25rem;
    font-weight: 400;
    line-height: 1.6;
    max-width: 30rem;
  }
  .sent-home {
    margin-top: 2rem;
    color: #dedede;
    font-weight: 600;
    text-decoration: none;
    transition: color var(--dur-2) var(--ease-hover);
  }
  @media (hover: hover) and (pointer: fine) {
    .sent-home:hover {
      color: #fff;
    }
  }
  .error {
    color: #ff6b6b;
  }
</style>
