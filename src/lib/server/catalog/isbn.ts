function digitsOnly(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

function isbn13ChecksumValid(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(s[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(s[12], 10);
}

function isbn10ChecksumValid(s: string): boolean {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(s[i], 10) * (10 - i);
  }
  const last = s[9] === "X" ? 10 : parseInt(s[9], 10);
  sum += last;
  return sum % 11 === 0;
}

export function isbn10To13(raw: string): string | null {
  const s = digitsOnly(raw).toUpperCase();
  if (!/^\d{9}[\dX]$/.test(s)) return null;
  if (!isbn10ChecksumValid(s)) return null;
  const core = "978" + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(core[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return core + String(check);
}

export function canonicalizeIsbn(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const s = digitsOnly(raw).toUpperCase();
  if (s.length === 13) {
    return isbn13ChecksumValid(s) ? s : null;
  }
  if (s.length === 10) {
    return isbn10To13(s);
  }
  return null;
}
