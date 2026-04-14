<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "$lib/i18n";
  import { relativeTime } from "$lib/time/relativeTime";

  type SaveStatus = "idle" | "saving" | "saved" | "error";

  let { highlightId, initialText, initialUpdatedAt, save, remove, onReady } =
    $props<{
      highlightId: string;
      initialText: string | null;
      initialUpdatedAt: string | null;
      save: (text: string) => Promise<void>;
      remove: () => Promise<void>;
      onReady?: (api: { handleDelete: () => Promise<void> }) => void;
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
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let displayEl: HTMLDivElement | undefined = $state();
  let needsShowMore = $state(false);

  const relativeStrings = {
    justNow: "just now",
    minutes: "{n}m ago",
    hours: "{n}h ago",
    yesterday: "Yesterday",
  };

  function scheduleSave(): void {
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
      if (seq !== saveSeq) return;
      await save(value);
    }
  }

  function enterEditor(): void {
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

  function onInput(): void {
    scheduleSave();
    autoresize();
  }

  function autoresize(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      exitEditorAndSave();
    }
  }

  export async function handleDelete(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveSeq++;
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

  $effect(() => {
    if (mode !== "display" || !displayEl) return;
    needsShowMore = displayEl.scrollHeight > displayEl.clientHeight + 2;
  });

  onMount(() => onReady?.({ handleDelete }));
</script>

<div class="note-area">
  <div
    class="note-saving"
    class:visible={status === "saving" ||
      status === "saved" ||
      status === "error"}
    class:error={status === "error"}
  >
    {#if status === "saving"}{$_("noteSaving")}{/if}
    {#if status === "saved"}{$_("noteSaved")}{/if}
    {#if status === "error"}{$_("noteFailed")}{/if}
  </div>

  {#if mode === "empty"}
    <div
      class="note-placeholder"
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
      {$_("addNote")}
    </div>
  {:else if mode === "display"}
    <div class="note-label">
      {$_("noteLabel")}:
      {#if updatedAt}
        <span class="note-time">
          {relativeTime(updatedAt, { strings: relativeStrings })}
        </span>
      {/if}
    </div>
    <div
      bind:this={displayEl}
      class="note-display"
      class:truncated={!expanded}
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
      {text}
    </div>
    {#if needsShowMore}
      <button
        class="note-show-more"
        style="display: inline"
        onclick={(e) => {
          e.stopPropagation();
          expanded = !expanded;
        }}
      >
        {expanded ? $_("showLess") : $_("showMore")}
      </button>
    {/if}
  {:else}
    <textarea
      bind:this={textareaEl}
      bind:value={text}
      class="note-editor"
      oninput={onInput}
      onblur={exitEditorAndSave}
      onkeydown={onKeydown}
      placeholder={$_("addNote")}
      rows="2"
    ></textarea>
  {/if}
</div>
