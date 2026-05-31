<script lang="ts">
  import { TRACKED_FIELDS } from "$lib/catalog/tracked-fields";
  import DlqArchiveSection from "./DlqArchiveSection.svelte";
  let { data, form } = $props();
  const row = $derived(data.row);
</script>

<p><a href="/app/admin">← Search</a></p>

<h1>{row.title ?? "(no title)"} — {row.author ?? "(no author)"}</h1>
<p>
  ID: <code>{row.id}</code><br />
  Key:
  <code
    >{row.isbn
      ? `ISBN ${row.isbn}`
      : `TA: ${row.normalized_title_author ?? "(none)"}`}</code
  >
</p>

{#if form && "message" in form && form.message}
  <p style="color:red;">{form.message}</p>
{/if}
{#if form && "ok" in form && form.ok}
  <p style="color:green;">Saved.</p>
  {#if "scheduledBgResolve" in form && form.scheduledBgResolve === false}
    <p style="color:#a16207;">
      Note: requeue stored, but no background resolve scheduled — this row has
      neither ISBN nor a usable title+author pair. Set one before re-requeueing.
    </p>
  {/if}
{/if}

<section>
  <h2>Description</h2>
  <p>
    Provider: <code>{row.description_provider ?? "—"}</code>, do_not_refetch:
    <code>{String(row.do_not_refetch_description)}</code>
  </p>
  <form method="POST" action="?/saveDescription">
    <textarea name="description" rows="6" cols="80" aria-label="Description"
      >{row.description ?? ""}</textarea
    >
    <div><button type="submit">Save description</button></div>
  </form>
  <form method="POST" action="?/takedown" style="margin-top:0.5rem;">
    <button type="submit">Takedown (clear + lock)</button>
  </form>
</section>

<section style="margin-top:1.5rem;">
  <h2>Cover</h2>
  {#if row.storage_path}
    <p>
      Stored: <code>{row.storage_path}</code> ({row.cover_storage_backend})<br
      />
      Source: <code>{row.cover_source ?? "—"}</code>, max width:
      <code>{row.cover_max_width ?? "—"}</code>
    </p>
  {:else}
    <p>No stored cover.</p>
  {/if}
  <form method="POST" action="?/uploadCover" enctype="multipart/form-data">
    <label
      >Cover file (JPEG/PNG/WebP, ≤5 MB)
      <input
        type="file"
        name="cover"
        accept="image/jpeg,image/png,image/webp"
      />
    </label>
    <div><button type="submit">Upload cover</button></div>
  </form>
</section>

{#if !row.isbn && row.normalized_title_author}
  <section style="margin-top:1.5rem;">
    <h2>Promote TA → ISBN</h2>
    <form method="POST" action="?/setIsbn">
      <label
        >ISBN
        <input name="isbn" placeholder="9780000000000" aria-label="ISBN" />
      </label>
      <button type="submit">Set ISBN</button>
    </form>
  </section>
{/if}

<section style="margin-top:1.5rem;">
  <h2>Requeue</h2>
  <form method="POST" action="?/requeue">
    {#each TRACKED_FIELDS as f}
      <label style="display:block;">
        <input type="checkbox" name="field_{f}" />
        {f}
      </label>
    {/each}
    {#each data.dlqArchive as r (r.id)}
      <input type="hidden" name="dlq_archive_id" value={r.id} />
    {/each}
    <button type="submit" style="margin-top:0.5rem;">Requeue selected</button>
  </form>
</section>

{#if !row.isbn}
  <section style="margin-top:1.5rem;">
    <h2>Merge duplicate rows</h2>
    <p style="color:#555;">
      Collapse other title+author rows that are the same book into THIS row (the
      survivor). Losers are deleted; their cover/metadata are not merged — pick
      the row with the best data as the survivor before merging.
    </p>
    <form method="POST" action="?/mergeDuplicates">
      {#if data.mergeCandidates.length > 0}
        <p>
          Suggested duplicates (same normalized title+author, different key):
        </p>
        {#each data.mergeCandidates as c (c.id)}
          <label style="display:block;">
            <input type="checkbox" name="loser_id" value={c.id} />
            <code>{c.normalized_title_author ?? "(no key)"}</code> —
            {c.title ?? "(no title)"} / {c.author ?? "(no author)"}
            {#if c.storage_path}
              (cover {c.cover_max_width ?? "?"}px, {c.cover_source ?? "—"})
            {:else}
              (no cover)
            {/if}
          </label>
        {/each}
      {:else}
        <p style="color:#555;">No auto-detected duplicates.</p>
      {/if}
      <label style="display:block; margin-top:0.5rem;">
        Additional duplicate row IDs (one per line — for differently-spelled
        titles a human recognizes as the same book):
        <textarea
          name="loser_id_manual"
          rows="3"
          cols="60"
          placeholder="00000000-0000-0000-0000-000000000000"
          aria-label="Additional duplicate row IDs"
        ></textarea>
      </label>
      <button type="submit" style="margin-top:0.5rem;"
        >Merge selected into this row</button
      >
    </form>
  </section>
{/if}

<p style="margin-top:2rem;">
  <a href="/app/admin/catalog/{row.id}/history">View action history →</a>
</p>

<DlqArchiveSection rows={data.dlqArchive} />
