<script lang="ts">
  let { data } = $props();
</script>

<h1>Search</h1>

<form method="GET">
  <input
    name="q"
    value={data.q}
    placeholder="ISBN or title prefix"
    aria-label="Search"
    style="width:24rem;"
  />
  <button type="submit">Search</button>
</form>

{#if data.results.length === 0 && data.q}
  <p>No matches.</p>
{:else if data.results.length > 0}
  <table style="margin-top:1rem; border-collapse:collapse;">
    <thead>
      <tr>
        <th style="text-align:left; padding-right:1rem;">ISBN</th>
        <th style="text-align:left; padding-right:1rem;">Title</th>
        <th style="text-align:left; padding-right:1rem;">Author</th>
        <th style="text-align:left; padding-right:1rem;">Cover</th>
        <th style="text-align:left; padding-right:1rem;">Description</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each data.results as row (row.id)}
        <tr>
          <td style="padding-right:1rem;"><code>{row.isbn ?? "(TA)"}</code></td>
          <td style="padding-right:1rem;">{row.title ?? ""}</td>
          <td style="padding-right:1rem;">{row.author ?? ""}</td>
          <td style="padding-right:1rem;">{row.storage_path ? "✓" : "—"}</td>
          <td style="padding-right:1rem;">{row.description ? "✓" : "—"}</td>
          <td><a href="/app/admin/catalog/{row.id}">Open</a></td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
