<script lang="ts">
  import { _ } from "$lib/i18n";
  import { relativeTime } from "$lib/time/relativeTime";

  type BookSummary = {
    book_hash: string;
    title: string | null;
    author: string | null;
    highlight_count: number;
    last_activity: string | null;
  };

  let { book } = $props<{ book: BookSummary }>();

  function initials(title: string | null): string {
    if (!title) return "??";
    const parts = title
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) return "??";
    const letters = parts
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("");
    return letters || "??";
  }

  const relativeStrings = {
    justNow: "just now",
    minutes: "{n}m ago",
    hours: "{n}h ago",
    yesterday: "Yesterday",
  };
</script>

<a class="card" href={`/app/book/${book.book_hash}`}>
  <div class="cover" aria-hidden="true">
    <span>{initials(book.title)}</span>
  </div>
  <div class="meta">
    <strong class="title">{book.title ?? "Untitled"}</strong>
    {#if book.author}
      <span class="author">{book.author}</span>
    {/if}
    <span class="count">
      {book.highlight_count === 1
        ? $_("dashboard.highlightCount_one", {
            values: { count: book.highlight_count },
          })
        : $_("dashboard.highlightCount_other", {
            values: { count: book.highlight_count },
          })}
    </span>
    <span class="activity">
      {$_("dashboard.lastActivity", {
        values: {
          when: book.last_activity
            ? relativeTime(book.last_activity, { strings: relativeStrings })
            : $_("dashboard.never"),
        },
      })}
    </span>
  </div>
</a>

<style>
  .card {
    display: flex;
    gap: 16px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    transition: border-color 120ms;
  }
  .card:hover {
    border-color: var(--border-hover);
  }
  .cover {
    flex-shrink: 0;
    width: 80px;
    height: 120px;
    border-radius: var(--radius-sm);
    background: linear-gradient(135deg, #3a5a80 0%, #1e3a5f 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 1.6rem;
    color: var(--highlight-bg);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .author {
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  .count,
  .activity {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
</style>
