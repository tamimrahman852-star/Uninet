/**
 * Uninet API Gateway - reverse proxy routing table.
 *
 *  - Path -> service routing with streaming (no body buffering, SSE-safe)
 *  - Auth and rate limiting come from ../middlewares
 *  - Authenticated WebSocket upgrade proxying for the chat service
 */
import { randomUUID } from 'node:crypto';
import { STATUS_CODES, ServerResponse, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';
import type { Application, NextFunction, Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import {
  attachIdentity,
  createAuthMiddleware,
  extractBearer,
  pathnameOf,
  sendError,
  stripIdentityHeaders,
  verifyAccessToken,
  type Handler,
  type PublicRule,
} from '../middlewares/auth.middleware';
import { createRateLimiter, createRedisClient, type RateLimitConfig } from '../middlewares/rate-limiter.middleware';

export type ServiceName = 'auth' | 'chat' | 'ecommerce' | 'media' | 'ai';

interface RouteConfig {
  service: ServiceName;
  prefix: string;
  auth: 'none' | 'required';
  publicWhen?: PublicRule[];
  rateLimit: RateLimitConfig;
  proxyTimeoutMs: number;
  websocket: boolean;
}

export interface ProxyRegistration {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => Promise<void>;
}

export const CRITICAL_SERVICES: ReadonlySet<ServiceName> = new Set<ServiceName>(['auth']);

export function getServiceTargets(): Record<ServiceName, string> {
  return {
    auth: process.env.AUTH_SERVICE_URL ?? 'http://auth-service:4001',
    chat: process.env.CHAT_SERVICE_URL ?? 'http://chat-service:4002',
    ecommerce: process.env.ECOMMERCE_SERVICE_URL ?? 'http://ecommerce-service:4003',
    media: process.env.MEDIA_SERVICE_URL ?? 'http://media-service:4004',
    ai: process.env.AI_SERVICE_URL ?? 'http://ai-service:4005',
  };
}

const MINUTE = 60_000;

const ROUTES: readonly RouteConfig[] = [
  {
    service: 'auth',
    prefix: '/api/v1/auth',
    auth: 'none',
    rateLimit: { windowMs: MINUTE, limit: 60 },
    proxyTimeoutMs: 15_000,
    websocket: false,
  },
  {
    service: 'chat',
    prefix: '/api/v1/chat',
    auth: 'required',
    rateLimit: { windowMs: MINUTE, limit: 600 },
    proxyTimeoutMs: 30_000,
    websocket: true,
  },
  {
    service: 'ecommerce',
    prefix: '/api/v1/shop',
    auth: 'required',
    publicWhen: [
      { method: 'GET', pattern: /^\/api\/v1\/shop\/(products|categories|search)(\/|$)/ },
      // Payment provider callbacks / webhooks cannot carry a user JWT; the service verifies them itself.
      { method: 'POST', pattern: /^\/api\/v1\/shop\/payments\/stripe\/webhook$/ },
      { method: 'POST', pattern: /^\/api\/v1\/shop\/payments\/sslcommerz\/(success|fail|cancel|ipn)$/ },
      { method: 'GET', pattern: /^\/api\/v1\/shop\/payments\/bkash\/callback$/ },
    ],
    rateLimit: { windowMs: MINUTE, limit: 300 },
    proxyTimeoutMs: 30_000,
    websocket: false,
  },
  {
    service: 'media',
    prefix: '/api/v1/media',
    auth: 'required',
    publicWhen: [{ method: 'GET', pattern: /^\/api\/v1\/media\/(videos|stream)(\/|$)/ }],
    rateLimit: { windowMs: MINUTE, limit: 600 },
    proxyTimeoutMs: 600_000,
    websocket: false,
  },
  {
    service: 'ai',
    prefix: '/api/v1/ai',
    auth: 'required',
    rateLimit: { windowMs: MINUTE, limit: 60 },
    proxyTimeoutMs: 300_000,
    websocket: false,
  },
];

export function getRouteSummary(): Array<Record<string, unknown>> {
  const targets = getServiceTargets();
  return ROUTES.map((r) => ({
    service: r.service,
    prefix: r.prefix,
    target: targets[r.service],
    auth: r.auth,
    public_rules: r.publicWhen?.length ?? 0,
    rate_limit: r.rateLimit,
    websocket: r.websocket,
  }));
}

const logger = new Logger('ProxyRoutes');

const matchesPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const isSuspiciousPath = (pathname: string): boolean =>
  /(^|\/)\.\.(\/|$)/.test(pathname) || /%2e|%2f|%5c|%00/i.test(pathname);

function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
  socket.destroy();
}

function compose(handlers: Handler[]): Handler {
  return (req, res, next) => {
    let index = 0;
    const run = (err?: unknown): void => {
      if (err) {
        next(err);
        return;
      }
      const handler = handlers[index++];
      if (!handler) {
        next();
        return;
      }
      try {
        const result = handler(req, res, run);
        if (result instanceof Promise) result.catch((e: unknown) => next(e));
      } catch (e) {
        next(e);
      }
    };
    run();
  };
}

function createProxy(name: string, route: RouteConfig, target: string) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: route.proxyTimeoutMs,
    timeout: route.proxyTimeoutMs,
    on: {
      proxyRes: (proxyRes) => {
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        if (contentType.includes('text/event-stream')) {
          proxyRes.headers['cache-control'] = 'no-cache, no-transform';
          proxyRes.headers['x-accel-buffering'] = 'no';
        }
      },
      error: (err, req, res) => {
        const code = (err as NodeJS.ErrnoException).code;
        const timedOut = code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNRESET';
        const status = timedOut ? 504 : 502;
        logger.error(`[${name}] upstream error ${code ?? err.message} on ${req.method} ${req.url}`);
        if (res instanceof ServerResponse) {
          if (!res.headersSent) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  code: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
                  message: `The ${name} service is currently unavailable`,
                },
              }),
            );
          } else {
            res.end();
          }
        } else {
          res.destroy();
        }
      },
    },
  });
}

export function registerProxyRoutes(app: Application): ProxyRegistration {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is required for the API gateway');
  const gatewaySecret = process.env.INTERNAL_GATEWAY_SECRET || undefined;
  const targets = getServiceTargets();
  const redis = createRedisClient(process.env.REDIS_URL);

  // Reject path traversal / encoded separators before any routing decision is made.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isSuspiciousPath(pathnameOf(req.originalUrl))) {
      sendError(res, 400, 'bad_request', 'Malformed request path');
      return;
    }
    next();
  });

  const websocketRoutes: Array<{ route: RouteConfig; proxy: ReturnType<typeof createProxy> }> = [];

  for (const route of ROUTES) {
    const target = targets[route.service];
    const proxy = createProxy(route.service, route, target);
    const chain = compose([
      createAuthMiddleware({ mode: route.auth, publicWhen: route.publicWhen, jwtSecret: secret, gatewaySecret }),
      createRateLimiter(route.service, route.rateLimit, redis),
      proxy as unknown as Handler,
    ]);
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (matchesPrefix(pathnameOf(req.originalUrl), route.prefix)) {
        chain(req, res, next);
        return;
      }
      next();
    });
    if (route.websocket) websocketRoutes.push({ route, proxy });
    logger.log(`Route ${route.prefix} -> ${target} (auth: ${route.auth}${route.websocket ? ', websocket' : ''})`);
  }

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.local');
    } catch {
      rejectUpgrade(socket, 400, 'bad_request', 'Malformed request URL');
      return;
    }
    if (isSuspiciousPath(url.pathname)) {
      rejectUpgrade(socket, 400, 'bad_request', 'Malformed request path');
      return;
    }
    const match = websocketRoutes.find(({ route }) => matchesPrefix(url.pathname, route.prefix));
    if (!match) {
      rejectUpgrade(socket, 404, 'not_found', 'No WebSocket route');
      return;
    }

    stripIdentityHeaders(req.headers);
    // Browsers cannot set headers on WebSocket handshakes, so a query token is accepted too.
    const token = extractBearer(req.headers) ?? url.searchParams.get('access_token') ?? undefined;
    if (!token) {
      rejectUpgrade(socket, 401, 'unauthorized', 'Missing access token');
      return;
    }
    try {
      attachIdentity(req.headers, verifyAccessToken(token, secret));
    } catch (err) {
      const expired = err instanceof jwt.TokenExpiredError;
      rejectUpgrade(socket, 401, expired ? 'token_expired' : 'invalid_token', 'Invalid access token');
      return;
    }
    if (gatewaySecret) req.headers['x-gateway-secret'] = gatewaySecret;
    if (!req.headers['x-request-id']) req.headers['x-request-id'] = randomUUID();

    match.proxy.upgrade?.(req, socket as Socket, head);
  };

  return {
    handleUpgrade,
    close: async () => {
      if (redis) await redis.quit().catch(() => undefined);
    },
  };
}
