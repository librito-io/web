<script lang="ts">
  let { data } = $props();
</script>

<p><a href="/app/admin/catalog/{data.catalogId}">← Back to row</a></p>

<h1>Action history</h1>

{#if data.rows.length === 0}
  <p>No actions recorded yet.</p>
{:else}
  {#each data.rows as a (a.id)}
    <article style="border:1px solid #ddd; padding:0.5rem; margin:0.5rem 0;">
      <header>
        <strong>{a.action}</strong> ·
        <time>{new Date(a.created_at).toISOString()}</time>
        <span style="color:#666;"
          >· admin <code>{a.admin_user_id.slice(0, 8)}…</code></span
        >
      </header>
      <details>
        <summary>before</summary>
        <pre style="max-height:20rem; overflow:auto;">{JSON.stringify(
            a.before_jsonb,
            null,
            2,
          )}</pre>
      </details>
      <details>
        <summary>after</summary>
        <pre style="max-height:20rem; overflow:auto;">{JSON.stringify(
            a.after_jsonb,
            null,
            2,
          )}</pre>
      </details>
    </article>
  {/each}
{/if}
