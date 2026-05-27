<script lang="ts">
  import { TRACKED_FIELDS } from "$lib/server/catalog/tracked-fields";
  let { data } = $props();

  type HistoryRow = (typeof data.history)[number];

  function fillRate(row: HistoryRow, field: string): number {
    if (row.total_rows === 0) return 0;
    const missing = row[`missing_${field}` as keyof HistoryRow] as number;
    return (row.total_rows - missing) / row.total_rows;
  }
</script>

<h1>Catalog fill rate (last {data.history.length} weeks)</h1>

{#if data.history.length === 0}
  <p>
    No snapshots yet. First cron run fires Monday 09 UTC after
    <code>CATALOG_FILL_RATE_ENABLED=true</code> is set in Vercel.
  </p>
{:else}
  <table style="border-collapse:collapse; margin-top:1rem;">
    <thead>
      <tr>
        <th style="text-align:left; padding-right:1rem;">Field</th>
        {#each data.history as h (h.snapshot_at)}
          <th style="text-align:right; padding-right:0.5rem;">
            {new Date(h.snapshot_at).toISOString().slice(0, 10)}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each TRACKED_FIELDS as f (f)}
        <tr>
          <td style="padding-right:1rem;"><code>{f}</code></td>
          {#each data.history as h (h.snapshot_at)}
            <td style="text-align:right; padding-right:0.5rem;">
              {(fillRate(h, f) * 100).toFixed(0)}%
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>

  <h2 style="margin-top:2rem;">Description provider distribution (latest)</h2>
  {#if data.history.length > 0}
    {@const latest = data.history[data.history.length - 1]}
    <table style="border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left; padding-right:1rem;">Provider</th>
          <th style="text-align:right;">Count</th>
        </tr>
      </thead>
      <tbody>
        <tr
          ><td>openlibrary</td><td style="text-align:right;"
            >{latest.desc_from_openlibrary}</td
          ></tr
        >
        <tr
          ><td>google_books</td><td style="text-align:right;"
            >{latest.desc_from_google_books}</td
          ></tr
        >
        <tr
          ><td>itunes</td><td style="text-align:right;"
            >{latest.desc_from_itunes}</td
          ></tr
        >
        <tr
          ><td>manual</td><td style="text-align:right;"
            >{latest.desc_from_manual}</td
          ></tr
        >
      </tbody>
    </table>
  {/if}
{/if}

<p style="margin-top:2rem; color:#666;">
  Sparkline visualization deferred to follow-up (spec "Out of scope").
</p>
