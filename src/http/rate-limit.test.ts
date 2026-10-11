import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("rate limiter", () => {
  it("allows up to the limit, then refuses with the seconds until the window ends", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    expect(limiter("a")).toEqual({ allowed: true });
    t += 10_000;
    expect(limiter("a")).toEqual({ allowed: true });
    expect(limiter("a")).toEqual({ allowed: false, retryAfterSeconds: 50 });
  });

  it("starts a fresh window once the old one has ended", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    limiter("a");
    expect(limiter("a").allowed).toBe(false);
    t = 1000;
    expect(limiter("a")).toEqual({ allowed: true });
    expect(limiter("a").allowed).toBe(false);
  });

  it("counts each key on its own", () => {
    const limiter = createRateLimiter({ limit: 1, now: () => 0 });
    limiter("a");
    expect(limiter("a").allowed).toBe(false);
    expect(limiter("b")).toEqual({ allowed: true });
  });

  it("rounds a partial second up", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    limiter("a");
    t = 999;
    expect(limiter("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("defaults to 120 requests a minute", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    for (let i = 0; i < 120; i++) expect(limiter("a").allowed).toBe(true);
    expect(limiter("a")).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });
});
