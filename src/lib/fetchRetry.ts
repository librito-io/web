export async function fetchWithSafariRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    // Safari/WebKit reuses idle HTTP keep-alive sockets the server already
    // closed; first request fails mid-flight with "Load failed" / "network
    // connection was lost". Retry once on a fresh connection.
    return await fetch(input, init);
  }
}
