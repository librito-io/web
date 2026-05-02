const AWARD_KEYWORDS = [
  "WINNER",
  "FINALIST",
  "SHORTLISTED",
  "LONGLISTED",
  "BEST",
  "BOOK OF",
  "PICK",
  "FAVOURITE",
  "FAVORITE",
  "MOST ANTICIPATED",
  "BESTSELLER",
  "BESTSELLING",
  "NEW YORK TIMES",
  "USA TODAY",
  "NPR",
];

function isAwardLine(line: string): boolean {
  const s = line.trim();
  if (s.length < 5 || s.length > 200) return false;
  // Heuristic: predominantly uppercase letters / digits / spaces / punctuation,
  // and contains at least one award keyword.
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  const upperLetters = s.replace(/[^A-Z]/g, "");
  if (upperLetters.length / letters.length < 0.85) return false;
  return AWARD_KEYWORDS.some((kw) => s.includes(kw));
}

function isPullQuoteLine(line: string): boolean {
  const s = line.trim();
  if (s.length === 0 || s.length > 200) return false;
  // Must open within the first 5 characters AND close within the last 20.
  // Anchor both ends to avoid removing legitimate sentences that happen
  // to contain a quoted span in the middle.
  const opensEarly = /^[\s]*[“”‘’"']/.test(s.slice(0, 5));
  if (!opensEarly) return false;
  const closesLate = /[“”‘’"'][^“”‘’"']*[—\-]?[^“”‘’"']*$/.test(s.slice(-30));
  return closesLate;
}

function isTrailingSourceLine(line: string): boolean {
  return /^Source\s*:/.test(line.trim());
}

export function stripMarketingCruft(raw: string): string {
  if (!raw) return raw;
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (isAwardLine(line)) continue;
    if (isPullQuoteLine(line)) continue;
    if (isTrailingSourceLine(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
