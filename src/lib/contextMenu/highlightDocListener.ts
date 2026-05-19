// Document-level capture-phase contextmenu listener so right-click anywhere
// inside a `.book-card.expanded` opens the custom menu — not only on the
// inner blockquote. Capture phase is required because Safari suppresses the
// bubble for native contextmenu events, so bubble-phase listeners can't
// reliably preventDefault.

export type HighlightContextMenuPayload = {
  x: number;
  y: number;
  highlightId: string;
  text: string;
  hasNote: boolean;
};

export type InstallOpts = {
  // Page-owned lookup for the highlight text (kept off the DOM so we don't
  // duplicate every highlight body into a `data-*` attribute). Reactive
  // note-state lives on the blockquote dataset instead.
  resolveText: (highlightId: string) => string | null;
  onMenu: (payload: HighlightContextMenuPayload) => void;
  onHide: () => void;
};

function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && sel.toString().trim().length > 0;
}

function pickBlockquoteByMouse(
  card: Element,
  clientY: number,
): HTMLElement | null {
  const blockquotes = card.querySelectorAll<HTMLElement>(
    "blockquote[data-highlight-id]",
  );
  if (blockquotes.length === 0) return null;
  if (blockquotes.length === 1) return blockquotes[0];
  let best: HTMLElement = blockquotes[0];
  let bestDist = Infinity;
  for (const bq of blockquotes) {
    const r = bq.getBoundingClientRect();
    const mid = (r.top + r.bottom) / 2;
    const dist = Math.abs(mid - clientY);
    if (dist < bestDist) {
      bestDist = dist;
      best = bq;
    }
  }
  return best;
}

export function installHighlightContextMenuListener(
  opts: InstallOpts,
): () => void {
  function onContextMenu(e: MouseEvent): void {
    // User has selected text — let the native menu through (copy/translate).
    if (hasTextSelection()) return;

    const target = e.target as Element | null;
    if (!target) return;

    // Don't steal the native menu from form controls: users want
    // spellcheck/dictionary suggestions inside the note editor textarea.
    if (target.closest("input, textarea, [contenteditable='true']")) return;

    let blockquote: HTMLElement | null =
      target.closest<HTMLElement>("blockquote[data-highlight-id]") ?? null;
    if (!blockquote) {
      const card = target.closest(".book-card.expanded");
      if (!card) {
        // Right-click outside any card while the menu is open: dismiss so
        // the native menu shows alone.
        opts.onHide();
        return;
      }
      blockquote = pickBlockquoteByMouse(card, e.clientY);
    }
    if (!blockquote) {
      opts.onHide();
      return;
    }

    const id = blockquote.getAttribute("data-highlight-id");
    if (!id) return;
    const text = opts.resolveText(id);
    if (text === null) return;
    const hasNote = blockquote.getAttribute("data-has-note") === "true";

    e.preventDefault();
    opts.onMenu({
      x: e.clientX,
      y: e.clientY,
      highlightId: id,
      text,
      hasNote,
    });
  }

  document.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    document.removeEventListener("contextmenu", onContextMenu, true);
  };
}
