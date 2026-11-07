import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { logJson } from './logger';

/**
 * Express middleware that, for every response (even ones rejected by guards
 * before a Nest interceptor would run), records HTTP metrics and emits one
 * structured log line. A per-request id is attached and echoed as
 * `x-request-id` for client/server correlation.
 */
export function observabilityMiddleware(metrics: MetricsService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const reqId = (req.headers['x-request-id'] as string) || randomUUID();
    (req as any).id = reqId;
    res.setHeader('x-request-id', reqId);
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // Low-cardinality route label: the matched route pattern (…/:id), never
      // the raw URL. Unmatched requests (404s) collapse to a single series.
      const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';

      // The /metrics scrape should not count itself.
      if (route !== '/metrics') {
        metrics.observeHttp(req.method, route, res.statusCode, seconds);
      }

      // Identity is attached by the auth guards (when the route is authenticated).
      const principal = (req as any).principal;
      const user = (req as any).user;
      logJson({
        level: res.statusCode >= 500 ? 'error' : 'info',
        msg: 'http_request',
        reqId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
        tenantId: principal?.tenantId,
        userId: user?.userId,
      });
    });

    next();
  };
}
