import { config } from './config.js';

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + config.rateLimitWindowMs
      });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (bucket.count >= config.rateLimitMaxRequests) {
      return {
        allowed: false,
        retryAfterMs: Math.max(bucket.resetAt - now, 0)
      };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}
