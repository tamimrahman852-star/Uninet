/**
 * Gateway authentication middleware.
 *
 * - Verifies Supabase (HS256) access tokens.
 * - Strips every client-supplied identity header and re-adds trusted ones (x-user-id, x-user-role, x-user-email).
 * - Adds x-gateway-secret so downstream services can verify the request came through the gateway.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export interface GatewayUser {
  id: string;
  email?: string;
  role: string;
  exp?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: GatewayUser;
    }
  }
}

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export interface PublicRule {
  /** HTTP method, or '*' for any */
  method: string;
  pattern: RegExp;
}

export interface AuthOptions {
  /** 'none': upstream authenticates itself. 'required': a valid JWT is needed unless a publicWhen rule matches. */
  mode: 'none' | 'required';
  publicWhen?: PublicRule[];
  jwtSecret: string;
  gatewaySecret?: string;
}

export const IDENTITY_HEADERS = ['x-user-id', 'x-user-email', 'x-user-role', 'x-gateway-secret'] as const;

export const pathnameOf = (url: string): string => {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
};

export function stripIdentityHeaders(headers: IncomingHttpHeaders): void {
  for (const name of IDENTITY_HEADERS) delete headers[name];
}

export function extractBearer(headers: IncomingHttpHeaders): string | undefined {
  const header = headers.authorization;
  if (typeof header === 'string' && /^bearer\s+/i.test(header)) {
    const token = header.replace(/^bearer\s+/i, '').trim();
    return token.length > 0 ? token : undefined;
  }
  return undefined;
}

export function verifyAccessToken(token: string, secret: string): GatewayUser {
  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    audience: 'authenticated',
    clockTolerance: 5,
  });
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string' || decoded.sub.length === 0) {
    throw new Error('Token has no subject');
  }
  const appMetadata = (decoded as { app_metadata?: { role?: unknown } }).app_metadata;
  const email = (decoded as { email?: unknown }).email;
  return {
    id: decoded.sub,
    email: typeof email === 'string' ? email : undefined,
    role: typeof appMetadata?.role === 'string' ? appMetadata.role : 'user',
    exp: decoded.exp,
  };
}

export function attachIdentity(headers: IncomingHttpHeaders, user: GatewayUser): void {
  headers['x-user-id'] = user.id;
  headers['x-user-role'] = user.role;
  if (user.email) headers['x-user-email'] = user.email;
}

export function sendError(res: Response, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  const requestId = res.getHeader('x-request-id');
  res.status(status).json({ error: { code, message, request_id: requestId } });
}

export function createAuthMiddleware(options: AuthOptions): Handler {
  return (req, res, next) => {
    stripIdentityHeaders(req.headers);
    if (options.gatewaySecret) req.headers['x-gateway-secret'] = options.gatewaySecret;

    if (options.mode === 'none') {
      next();
      return;
    }

    const token = extractBearer(req.headers);
    const pathname = pathnameOf(req.originalUrl);
    const isPublic =
      options.publicWhen?.some((rule) => (rule.method === '*' || rule.method === req.method) && rule.pattern.test(pathname)) ??
      false;

    if (!token) {
      if (isPublic) {
        next();
        return;
      }
      sendError(res, 401, 'unauthorized', 'Missing bearer token');
      return;
    }

    try {
      const user = verifyAccessToken(token, options.jwtSecret);
      req.user = user;
      attachIdentity(req.headers, user);
      next();
    } catch (err) {
      const expired = err instanceof jwt.TokenExpiredError;
      res.setHeader('WWW-Authenticate', `Bearer error="invalid_token"${expired ? ', error_description="expired"' : ''}`);
      sendError(res, 401, expired ? 'token_expired' : 'invalid_token', expired ? 'Access token expired' : 'Invalid access token');
    }
  };
}
