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
