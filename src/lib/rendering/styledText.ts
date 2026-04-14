export type StyledRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  isBreak?: boolean;
};

type Style = { bold: boolean; italic: boolean };

const STYLE_FOR_CODE: Record<string, Style> = {
  R: { bold: false, italic: false },
  B: { bold: true, italic: false },
  I: { bold: false, italic: true },
  // "H" (heading) and any future codes fall back to bold for display purposes.
  H: { bold: true, italic: false },
};

/**
 * Parses a run-length-encoded styles string like "R45B12I5" — 45 chars regular,
 * then 12 bold, then 5 italic. Returns runs sliced against `text`.
 *
 * If `styles` is missing, malformed, or its total length differs from
 * `text.length`, the whole string is returned as a single regular run.
 *
 * Embedded "\n" characters in `text` are emitted as standalone runs with
 * `isBreak: true` so callers can render paragraph breaks.
 */
export function renderStyledText(
  text: string,
  styles?: string | null,
): StyledRun[] {
  const parsed = styles ? parseStyles(styles) : null;
  const spans =
    parsed && totalLength(parsed) === text.length
      ? parsed
      : [{ style: STYLE_FOR_CODE.R, length: text.length }];

  const out: StyledRun[] = [];
  let offset = 0;
  for (const span of spans) {
    const chunk = text.slice(offset, offset + span.length);
    offset += span.length;
    for (const piece of splitOnBreaks(chunk, span.style)) out.push(piece);
  }
  if (out.length === 0) {
    out.push({ text: "", bold: false, italic: false });
  }
  return out;
}

function parseStyles(
  styles: string,
): { style: Style; length: number }[] | null {
  const re = /([A-Z])(\d+)/g;
  const runs: { style: Style; length: number }[] = [];
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(styles))) {
    if (match.index !== consumed) return null;
    const [, code, digits] = match;
    const style = STYLE_FOR_CODE[code];
    if (!style) return null;
    const length = Number.parseInt(digits, 10);
    if (!Number.isFinite(length) || length <= 0) return null;
    runs.push({ style, length });
    consumed = re.lastIndex;
  }
  if (consumed !== styles.length || runs.length === 0) return null;
  return runs;
}

function totalLength(runs: { length: number }[]): number {
  return runs.reduce((s, r) => s + r.length, 0);
}

function splitOnBreaks(chunk: string, style: Style): StyledRun[] {
  if (!chunk.includes("\n")) {
    return chunk.length
      ? [{ text: chunk, bold: style.bold, italic: style.italic }]
      : [];
  }
  const out: StyledRun[] = [];
  const parts = chunk.split("\n");
  parts.forEach((part, i) => {
    if (part.length)
      out.push({ text: part, bold: style.bold, italic: style.italic });
    if (i < parts.length - 1)
      out.push({ text: "\n", bold: false, italic: false, isBreak: true });
  });
  return out;
}
