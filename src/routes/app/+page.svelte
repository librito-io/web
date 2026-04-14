<script lang="ts">
  import { _ } from "$lib/i18n";
  import BookCard from "$lib/components/BookCard.svelte";

  let { data } = $props();
</script>

<section class="dashboard">
  <h1>{$_("dashboard.title")}</h1>

  {#if data.books.length === 0}
    <p class="empty">{$_("dashboard.empty")}</p>
  {:else}
    <div class="grid">
      {#each data.books as book (book.id)}
        <BookCard {book} />
      {/each}
    </div>
  {/if}
</section>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  h1 {
    font-size: 1.4rem;
    font-weight: 600;
  }
  .empty {
    color: var(--text-secondary);
    padding: 40px 0;
    text-align: center;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
</style>
