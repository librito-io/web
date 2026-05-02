import type { RequestEvent } from "@sveltejs/kit";

interface WaitUntilHost {
  platform?: { context?: { waitUntil?: (p: Promise<unknown>) => void } };
}

export function runInBackground(
  event: RequestEvent | WaitUntilHost,
  work: () => Promise<unknown>,
): void {
  const promise = work().catch((err) => {
    console.error("wait-until-failed", err);
  });
  const wu = (event as WaitUntilHost).platform?.context?.waitUntil;
  if (typeof wu === "function") {
    wu(promise);
    return;
  }
  // Local dev / non-Vercel runtime: ignore — promise is already running and
  // its rejection is captured by the .catch above.
}
