/**
 * Uninet API Gateway - NestJS bootstrap.
 *
 * The body parser is intentionally disabled: request bodies are streamed untouched to the upstream
 * services (uploads, SSE and WebSocket traffic must never be buffered here). See .env.example.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Application, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { registerProxyRoutes } from './proxy/routes.proxy';

function parseCorsOrigins(): string[] | boolean {
  const raw = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (raw.length > 0) return raw;
  return process.env.NODE_ENV !== 'production';
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Gateway');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  app.enableCors({
    origin: parseCorsOrigins(),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Request-Id', 'Last-Event-ID', 'Range', 'X-Upload-Chunk-Index'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit', 'RateLimit-Policy', 'Content-Range', 'Accept-Ranges'],
    maxAge: 600,
  });

  // Request id + structured access log.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger.log(
        JSON.stringify({
          request_id: id,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          duration_ms: Math.round(durationMs),
          user_id: req.user?.id,
          ip: req.ip,
        }),
      );
    });
    next();
  });

  const proxies = registerProxyRoutes(app.getHttpAdapter().getInstance() as Application);

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port, '0.0.0.0');

  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('upgrade', proxies.handleUpgrade);

  logger.log(`API gateway listening on :${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      await proxies.close();
      process.exit(0);
    } catch (err) {
      logger.error(`Shutdown failed: ${(err as Error).message}`);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  new Logger('Gateway').error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

bootstrap().catch((err: unknown) => {
  new Logger('Gateway').error(`Failed to start: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
