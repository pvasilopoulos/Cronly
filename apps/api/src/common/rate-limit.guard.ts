import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export interface RateLimitOptions {
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Bucket name — keeps a route's budget separate from the global one. */
  name?: string;
}

export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * Override the default rate limit for a route or controller, e.g.
 * `@RateLimit({ limit: 20, windowMs: 60_000, name: 'login' })` to throttle
 * brute-force login attempts harder than ordinary traffic.
 */
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

const DEFAULT: RateLimitOptions = { limit: 600, windowMs: 60_000, name: 'global' };

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A dependency-free, in-memory fixed-window rate limiter. Good enough to blunt
 * brute-force and runaway clients on a single-node deployment; swap for a Redis
 * token bucket when the API runs multi-instance.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private lastPrune = Date.now();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const opts =
      this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT;

    const req = context.switchToHttp().getRequest();
    const identity = this.identify(req);
    const key = `${opts.name ?? 'global'}:${identity}`;
    const now = Date.now();

    this.pruneIfDue(now);

    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;

    if (bucket.count > opts.limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      const res = context.switchToHttp().getResponse();
      res?.setHeader?.('Retry-After', String(retryAfter));
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests, slow down.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Prefer the API key, then the authenticated bearer, then the client IP. */
  private identify(req: any): string {
    const header: string | undefined = req.headers?.['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer cak_')) {
      // Identify by the key, not the IP — a key's budget follows the key.
      return 'k:' + header.slice(7, 19);
    }
    const fwd = req.headers?.['x-forwarded-for'];
    const ip =
      (typeof fwd === 'string' ? fwd.split(',')[0].trim() : undefined) ||
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown';
    return 'ip:' + ip;
  }

  /** Drop expired buckets occasionally so the map cannot grow unbounded. */
  private pruneIfDue(now: number): void {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(k);
    }
  }
}
