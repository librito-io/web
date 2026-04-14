import { json } from "@sveltejs/kit";

export function jsonError(
  status: number,
  error: string,
  message: string,
  retryAfter?: number,
): Response {
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) {
    headers["Retry-After"] = String(retryAfter);
  }
  return json({ error, message }, { status, headers });
}

export function jsonSuccess(data: object): Response {
  return json(data);
}
