<script lang="ts">
  let { message = $bindable<string | null>(null), durationMs = 2000 } = $props<{
    message: string | null;
    durationMs?: number;
  }>();

  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (message === null) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      message = null;
    }, durationMs);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });
</script>

{#if message}
  <div class="toast" role="status" aria-live="polite">{message}</div>
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: 32px;
    transform: translateX(-50%);
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 16px;
    font-size: 0.9rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    z-index: 1000;
    animation: fade-in 150ms ease-out;
  }
  @keyframes fade-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
</style>
