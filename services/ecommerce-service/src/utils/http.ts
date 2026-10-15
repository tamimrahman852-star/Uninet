import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);

/** Rejects requests that did not come through the API gateway (when INTERNAL_GATEWAY_SECRET is set). */
export const gatewayOnly: RequestHandler = (req, _res, next) => {
  const expected = env.INTERNAL_GATEWAY_SECRET;
  if (!expected || req.path === '/healthz' || req.path === '/readyz') {
    next();
    return;
  }
  const provided = req.headers['x-gateway-secret'];
  const a = Buffer.from(typeof provided === 'string' ? provided : '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    next(new HttpError(403, 'forbidden', 'Requests must come through the API gateway'));
    return;
  }
  next();
};

/** Reads the identity headers set by the gateway. */
export const attachUser: RequestHandler = (req, _res, next) => {
  const id = req.headers['x-user-id'];
  if (typeof id === 'string' && isUuid(id)) {
    const role = req.headers['x-user-role'];
    const email = req.headers['x-user-email'];
    req.user = {
      id,
      role: typeof role === 'string' ? role : 'user',
      email: typeof email === 'string' ? email : undefined,
    };
  }
  next();
};

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(new HttpError(401, 'unauthorized', 'Authentication required'));
    return;
  }
  next();
};

export const requireRole =
  (...roles: string[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) {
      next(new HttpError(401, 'unauthorized', 'Authentication required'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new HttpError(403, 'forbidden', 'You do not have permission to perform this action'));
      return;
    }
    next();
  };
