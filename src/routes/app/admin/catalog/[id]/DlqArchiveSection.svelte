<script lang="ts">
  interface DlqRow {
    id: number;
    message_id: string;
    first_failed_at: string;
    fail_reason: string | null;
    archived_at: string;
    manually_requeued_at: string | null;
    payload: unknown;
  }
  let { rows }: { rows: DlqRow[] } = $props();
</script>

<section>
  <h2>DLQ archive ({rows.length})</h2>
  {#if rows.length === 0}
    <p>No DLQ entries for this catalog row.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>message_id</th>
          <th>first_failed_at</th>
          <th>fail_reason</th>
          <th>archived_at</th>
          <th>manually_requeued_at</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.id)}
          <tr data-testid="dlq-row-{r.id}">
            <td><code>{r.message_id}</code></td>
            <td>{r.first_failed_at}</td>
            <td>{r.fail_reason ?? "—"}</td>
            <td>{r.archived_at}</td>
            <td>{r.manually_requeued_at ?? "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p>
      Use the existing <strong>requeue</strong> action above to manually
      re-queue. It stamps <code>manually_requeued_at</code> on every matching row.
    </p>
  {/if}
</section>
