<script lang="ts">
  import { _ } from "$lib/i18n";
  import { relativeTime } from "$lib/time/relativeTime";

  type SaveStatus = "idle" | "saving" | "saved" | "error";

  let { highlightId, initialText, initialUpdatedAt, save, remove } = $props<{
    highlightId: string;
    initialText: string | null;
    initialUpdatedAt: string | null;
    save: (text: string) => Promise<void>;
    remove: () => Promise<void>;
  }>();

  let text = $state(initialText ?? "");
  let persistedText = $state(initialText ?? "");
  let updatedAt = $state(initialUpdatedAt);
  let mode = $state<"empty" | "display" | "editor">(
    initialText && initialText.length > 0 ? "display" : "empty",
  );
  let status = $state<SaveStatus>("idle");
  let expanded = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saveSeq = 0;
  let textareaEl: HTMLTextAreaElement;

  const relativeStrings = {
    justNow: "just now",
    minutes: "{n}m ago",
    hours: "{n}h ago",
    yesterday: "Yesterday",
  };

  function scheduleSave() {
    status = "saving";
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1500);
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const seq = ++saveSeq;
    const snapshot = text;
    status = "saving";
    try {
      await attemptSave(snapshot, seq);
      if (seq !== saveSeq) return;
      persistedText = snapshot;
      status = "saved";
      updatedAt = new Date().toISOString();
    } catch {
      if (seq !== saveSeq) return;
      status = "error";
    }
  }

  async function attemptSave(value: string, seq: number): Promise<void> {
    if (seq !== saveSeq) return;
    try {
      await save(value);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      if (seq !== saveSeq) return; // newer save superseded us during backoff
      await save(value);
    }
  }

  function enterEditor() {
    mode = "editor";
    expanded = false;
    queueMicrotask(() => textareaEl?.focus());
  }

  function exitEditorAndSave(): void {
    if (timer) clearTimeout(timer);
    if (text === persistedText) {
      mode = text.trim().length > 0 ? "display" : "empty";
      return;
    }
    flush().finally(() => {
      mode = text.trim().length > 0 ? "display" : "empty";
    });
  }

  function onInput() {
    scheduleSave();
    autoresize();
  }

  function autoresize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      exitEditorAndSave();
    }
  }

  async function handleDelete(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveSeq++; // invalidate any in-flight save so its late status write is ignored
    try {
      await remove();
      text = "";
      persistedText = "";
      updatedAt = null;
      mode = "empty";
      status = "idle";
    } catch {
      status = "error";
    }
  }

  $effect(() => {
    if (mode === "editor") autoresize();
  });
</script>

{#if mode === "empty"}
  <button class="placeholder" onclick={enterEditor}>
    {$_("note.placeholder")}
  </button>
{:else if mode === "display"}
  <div
    class="display"
    role="button"
    tabindex="0"
    onclick={enterEditor}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        enterEditor();
      }
    }}
  >
    <div class="head">
      <span class="label">{$_("note.label")}</span>
      {#if updatedAt}
        <span class="when"
          >{relativeTime(updatedAt, { strings: relativeStrings })}</span
        >
      {/if}
    </div>
    <p class="body" class:clamped={!expanded}>{text}</p>
    {#if text.length > 240}
      <button
        class="toggle"
        onclick={(e) => {
          e.stopPropagation();
          expanded = !expanded;
        }}
      >
        {expanded ? $_("note.showLess") : $_("note.showMore")}
      </button>
    {/if}
  </div>
{:else}
  <div class="editor">
    <textarea
      bind:this={textareaEl}
      bind:value={text}
      oninput={onInput}
      onblur={exitEditorAndSave}
      onkeydown={onKeydown}
      placeholder={$_("note.placeholder")}
      rows="2"
    ></textarea>
    <div class="foot">
      <span class="status" data-state={status}>
        {#if status === "saving"}{$_("note.saving")}
        {:else if status === "saved"}{$_("note.saved")}
        {:else if status === "error"}{$_("note.saveFailed")}
        {/if}
      </span>
      <button class="delete" onclick={handleDelete}>×</button>
    </div>
  </div>
{/if}

<style>
  .placeholder {
    color: var(--text-muted);
    padding: 8px 0;
    font-style: italic;
  }
  .display {
    padding: 10px 12px;
    border-left: 2px solid var(--border-hover);
    margin: 8px 0 16px;
    cursor: text;
  }
  .head {
    display: flex;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 0.8rem;
    margin-bottom: 4px;
  }
  .label {
    font-weight: 600;
  }
  .body {
    white-space: pre-wrap;
  }
  .body.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 8;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .toggle {
    margin-top: 4px;
    color: var(--accent);
    font-size: 0.85rem;
  }
  .editor {
    margin: 8px 0 16px;
  }
  textarea {
    width: 100%;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    caret-color: var(--accent);
    resize: none;
    min-height: 48px;
    font-family: var(--font-ui);
  }
  .foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 2px;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .status[data-state="error"] {
    color: var(--danger);
  }
  .status[data-state="saved"] {
    color: var(--text-secondary);
  }
  .delete {
    color: var(--text-muted);
    padding: 2px 8px;
  }
  .delete:hover {
    color: var(--danger);
  }
</style>
