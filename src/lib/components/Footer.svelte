<script lang="ts">
  import { _, locale } from "$lib/i18n";

  type Status = "idle" | "pending" | "success" | "error";
  let email = $state("");
  let company = $state(""); // honeypot
  let status = $state<Status>("idle");

  async function subscribe(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (status === "pending") return;
    status = "pending";
    try {
      const res = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, locale: $locale ?? "en", company }),
      });
      status = res.ok ? "success" : "error";
      if (res.ok) email = "";
    } catch {
      status = "error";
    }
  }
</script>

<footer class="site-footer">
  <div class="inner">
    <div class="newsletter">
      <h2>{$_("footerNewsletterHeading")}</h2>
      {#if status === "success"}
        <p class="msg success" role="status">{$_("footerSubscribeSuccess")}</p>
      {:else}
        <form onsubmit={subscribe}>
          <!-- Honeypot: hidden from humans, dropped server-side if filled. -->
          <input
            class="hp"
            type="text"
            name="company"
            tabindex="-1"
            autocomplete="off"
            aria-hidden="true"
            bind:value={company}
          />
          <label class="sr-only" for="footer-email"
            >{$_("footerEmailPlaceholder")}</label
          >
          <div class="field">
            <input
              id="footer-email"
              type="email"
              required
              placeholder={$_("footerEmailPlaceholder")}
              bind:value={email}
              disabled={status === "pending"}
            />
            <button
              type="submit"
              aria-label={$_("footerSubscribeAria")}
              disabled={status === "pending"}
            >
              <svg viewBox="0 0 46 24" fill="none" aria-hidden="true">
                <path
                  d="M2 12H42M31 2L42 12L31 22"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
          {#if status === "error"}
            <p class="msg error" role="alert">{$_("footerSubscribeError")}</p>
          {/if}
        </form>
      {/if}
    </div>

    <nav class="links" aria-label="Footer">
      <a href="/support">{$_("footerLinkSupport")}</a>
      <a href="/privacy">{$_("footerLinkPrivacy")}</a>
    </nav>
  </div>

  <div class="bottom">
    <span>© 2026 Librito</span>
  </div>
</footer>

<style>
  .site-footer {
    border-top: 1px solid #23262b;
    margin-top: 4rem;
    /* top 48px / sides 24px / bottom 64px. */
    padding: 3rem 1.5rem 4rem;
  }
  .inner {
    max-width: 1120px;
    margin: 0 auto;
    display: flex;
    justify-content: space-between;
    gap: 2rem;
    flex-wrap: wrap;
  }
  .newsletter h2 {
    font-size: 1.25rem;
    font-weight: 500;
    margin: 0 0 2rem;
  }
  .newsletter .field {
    display: flex;
    align-items: center;
    border-bottom: 1px solid #4a4f57;
    max-width: 26rem;
  }
  .newsletter input[type="email"] {
    flex: 1;
    background: transparent;
    border: none;
    color: #ededed;
    font: inherit;
    padding: 0.5rem 0;
  }
  .newsletter input[type="email"]:focus {
    outline: none;
  }
  .newsletter button {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    color: #017be4;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .newsletter button svg {
    width: 32px;
    height: auto;
  }
  .links {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
  }
  .links a {
    color: #c9c9c9;
    text-decoration: none;
  }
  .links a:hover {
    color: #fff;
  }
  .bottom {
    max-width: 1120px;
    /* Copyright sits below the newsletter/links row. No top divider rule —
       the gap alone separates it. */
    margin: 3.25rem auto 0;
    color: #8a8a8a;
    font-size: 0.85rem;
  }
  .msg.success {
    color: #7bd88f;
  }
  .msg.error {
    color: #ff6b6b;
  }
  .hp {
    position: absolute;
    left: -9999px;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  /* Mobile: stack newsletter over links. */
  @media (max-width: 599px) {
    .inner {
      flex-direction: column;
      gap: 2rem;
    }
  }
</style>
