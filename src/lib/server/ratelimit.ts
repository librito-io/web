import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} from "$env/static/private";

export const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// /api/pair/request — 3 requests per minute per IP
export const pairRequestLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1m"),
  prefix: "rl:pair:request",
});

// /api/pair/status/[pairingId] — 1 request per 3 seconds per IP
export const pairStatusLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "3s"),
  prefix: "rl:pair:status",
});

// /api/pair/claim — 5 attempts per 5 minutes per code:IP
export const pairClaimLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "5m"),
  prefix: "rl:pair:claim",
});

// /api/sync — 1 request per 30 seconds per device
export const syncLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "30s"),
  prefix: "rl:sync",
});

// Transfer: upload initiation (browser, per user)
export const transferUploadLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:upload",
});

// Transfer: download URL (device, per device)
export const transferDownloadLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "10s"),
  prefix: "rl:transfer:download",
});

// /api/realtime-token — two limiters layered for defense in depth.
// Per-device: 1 mint / 60 s. Bounds firmware-bug reconnect storms.
// Per-user: 30 mints / 1 h. Bounds re-pair-loop bypass (a logged-in user
// re-pairs to mint a new device.id and skip the per-device cap). 30/h
// covers a fleet of ~25 devices on one account with reconnect headroom.
export const realtimeTokenLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "60s"),
  prefix: "rl:realtime:token",
});

export const realtimeTokenUserLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "1h"),
  prefix: "rl:realtime:token:user",
});
