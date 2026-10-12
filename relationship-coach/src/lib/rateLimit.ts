// 단일 서버 프로세스용 메모리 요청 제한·중복 제출 방지.
// 여러 인스턴스로 배포하면 Redis 등 공유 저장소 기반으로 바꿔야 한다(README 참고).
// 키는 IP를 해시 없이 쓰되 메모리에만 두고, 창이 지나면 지운다. 원문은 다루지 않는다.

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** 허용되면 null, 막히면 다시 시도까지 남은 초. */
  hit(key: string, now = Date.now()): number | null {
    if (this.buckets.size > 10_000) this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    if (b.count >= this.max) return Math.ceil((b.resetAt - now) / 1000);
    b.count++;
    return null;
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }

  reset() {
    this.buckets.clear();
  }
}

/** 같은 requestId가 처리 중이거나 최근에 처리되었으면 거절한다. */
export class InFlightGuard {
  private seen = new Map<string, number>();
  constructor(private ttlMs = 5 * 60_000) {}

  acquire(id: string, now = Date.now()): boolean {
    for (const [k, t] of this.seen) if (t <= now) this.seen.delete(k);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + this.ttlMs);
    return true;
  }

  release(id: string) {
    this.seen.delete(id);
  }

  reset() {
    this.seen.clear();
  }
}

export function clientKey(headers: Headers): string {
  // 프록시 뒤에서는 신뢰할 수 있는 프록시가 넣은 헤더만 써야 한다(README 참고).
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers.get("x-real-ip") || "local";
}

const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);

export const analyzeLimiter = new FixedWindowLimiter(
  num(process.env.RATE_LIMIT_MAX, 8),
  num(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60_000),
);
export const replyLimiter = new FixedWindowLimiter(
  num(process.env.RATE_LIMIT_MAX, 8) * 2,
  num(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60_000),
);
export const reportLimiter = new FixedWindowLimiter(10, 10 * 60_000);
export const inFlight = new InFlightGuard();
