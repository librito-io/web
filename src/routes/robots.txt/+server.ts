import { env } from "$env/dynamic/public";
import type { RequestHandler } from "./$types";

// Pre-launch stealth: block all crawling until PUBLIC_LAUNCHED === "true".
// Discovery lever only — account creation is gated by Supabase enable_signup.
// Pairs with the <meta name="robots" content="noindex"> in +layout.svelte:
// robots.txt stops the crawl, the meta de-indexes anything already linked.
// $env/dynamic/public so an unset value reads "" (pre-launch default) and the
// route is never prerendered with a baked-in launch state.
export const GET: RequestHandler = () => {
  const launched = env.PUBLIC_LAUNCHED === "true";
  const body = launched
    ? "User-agent: *\nAllow: /\n"
    : "User-agent: *\nDisallow: /\n";
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
