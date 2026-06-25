<script lang="ts">
  import { _ } from "$lib/i18n";

  // Shared password field with a Cloudflare-style reveal toggle. Lives here (not
  // inlined per page) so login + signup share one a11y-correct treatment. The
  // eye is pinned to the trailing edge; Safari's native keychain/autofill button
  // drops in just to its left automatically (browser-owned, not ours).
  let {
    value = $bindable(""),
    label,
    autocomplete,
    minlength,
    required = false,
  }: {
    value?: string;
    label: string;
    autocomplete?: "current-password" | "new-password";
    minlength?: number;
    required?: boolean;
  } = $props();

  let revealed = $state(false);
</script>

<label>
  {label}
  <span class="pw-wrap">
    <input
      type={revealed ? "text" : "password"}
      bind:value
      {autocomplete}
      {minlength}
      {required}
    />
    <!-- type="button" so it never submits the form. aria-pressed announces the
         toggle state; aria-label flips so screen readers read the action.
         onmousedown preventDefault keeps focus on the input across the click:
         without it the button steals focus, the field's focus border snaps off,
         and Safari's keychain popover (anchored to the focused field) flashes
         dismiss/re-show on every toggle. Keyboard activation is unaffected —
         focus is already on the button before Space/Enter fires. -->
    <button
      type="button"
      class="pw-toggle"
      aria-pressed={revealed}
      aria-label={revealed ? $_("authPasswordHide") : $_("authPasswordShow")}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => (revealed = !revealed)}
    >
      {#if revealed}
        <!-- eye-slash (Phosphor, regular) — matches Cloudflare's dashboard. -->
        <svg
          width="20"
          height="20"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.16,133.16,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.64,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231.05,128a133.15,133.15,0,0,0-23.12-30.77C185.67,75.19,158.78,64,128,64a118.37,118.37,0,0,0-19.36,1.57A8,8,0,1,1,106,49.79,134,134,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z"
          />
        </svg>
      {:else}
        <!-- eye (Phosphor, regular) — matches Cloudflare's dashboard. -->
        <svg
          width="20"
          height="20"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z"
          />
        </svg>
      {/if}
    </button>
  </span>
</label>

<style>
  .pw-wrap {
    position: relative;
    display: block;
  }
  /* Full-width input + trailing room for the eye. Wins over AuthCard's global
     `input` rule on specificity (scoped class > single-class :global). */
  .pw-wrap input {
    width: 100%;
    box-sizing: border-box;
    padding-inline-end: 44px;
  }
  .pw-toggle {
    position: absolute;
    /* `inset-inline-end` keeps the eye on the trailing edge under RTL (ar).
       10px + the button's 6px padding = 16px from glyph to field edge. */
    inset-inline-end: 10px;
    top: 0;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    background: none;
    border: none;
    color: #8b8f95;
    cursor: pointer;
    transition: color var(--dur-2) var(--ease-hover);
  }
  .pw-toggle:hover {
    color: #dedede;
  }
  .pw-toggle:focus-visible {
    outline: none;
    color: #dedede;
    border-radius: 6px;
    box-shadow: 0 0 0 2px #dedede;
  }
</style>
