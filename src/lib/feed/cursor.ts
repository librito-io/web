export function encodeCursor(
  obj: Record<string, unknown> | null,
): string | null {
  if (obj === null) return null;
  const json = JSON.stringify(obj);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf8").toString("base64url");
  }
  // Browser path: base64url via btoa
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(
  value: string | null,
): Record<string, unknown> | null {
  if (!value) return null;
  try {
    let json: string;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(value, "base64url").toString("utf8");
    } else {
      const padded = value.replace(/-/g, "+").replace(/_/g, "/");
      const b64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
      json = decodeURIComponent(escape(atob(b64)));
    }
    const parsed = JSON.parse(json);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
