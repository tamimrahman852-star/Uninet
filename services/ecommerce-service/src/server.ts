/**
 * Uninet ecommerce-service - marketplace, cart checkout, orders, inventory and payments.
 *
 * Routes (mounted under /api/v1/shop, the gateway prefix):
 *   GET    /categories
 *   GET    /products            GET /products/:id          POST /products      PATCH|DELETE /products/:id
 *   GET    /inventory/:productId  PUT /inventory/:productId  POST /inventory/reap (admin)
 *   POST   /orders              GET /orders                GET /orders/:id
 *   POST   /orders/:id/pay      POST /orders/:id/cancel
 *   POST   /payments/stripe/webhook
 *   GET    /payments/bkash/callback
 *   POST   /payments/sslcommerz/(success|fail|cancel|ipn)
 */
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import Redis from 'ioredis';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { env, logger } from './config';
import { db } from './db';
import { InventoryController } from './controllers/inventory.controller';
import { OrderController } from './controllers/order.controller';
import { ProductController } from './controllers/product.controller';
import { PaymentService } from './services/payment.service';
import { LockTimeoutError, RedisLockService } from './services/redis-lock.service';
import { asyncHandler, attachUser, gatewayOnly, HttpError, requireRole, requireUser } from './utils/http';

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err: Error) => logger.error({ err }, 'Redis error'));

const locks = new RedisLockService(redis);
const payments = new PaymentService(redis);
const products = new ProductController(locks);
const inventory = new InventoryController(locks);
const orders = new OrderController(locks, payments);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(pinoHttp({ logger, genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID() }));
app.use(helmet());

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get(
  '/readyz',
  asyncHandler(async (_req, res) => {
    const [pong, dbCheck] = await Promise.all([
      redis.ping().catch(() => null),
      db.from('products').select('id', { head: true, count: 'estimated' }).limit(1),
    ]);
    if (pong !== 'PONG' || dbCheck.error) {
      res.status(503).json({ status: 'unavailable' });
      return;
    }
    res.json({ status: 'ok' });
  }),
);

const shop = express.Router();
shop.use(gatewayOnly);
shop.use(attachUser);

// Webhook needs the raw body for signature verification, so it is registered before the JSON parser.
shop.post('/payments/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), orders.stripeWebhook);

shop.use(express.json({ limit: '256kb' }));
shop.use(express.urlencoded({ extended: false, limit: '64kb' }));

shop.get('/payments/bkash/callback', orders.bkashCallback);
shop.post('/payments/sslcommerz/success', orders.sslSuccess);
shop.post('/payments/sslcommerz/ipn', orders.sslIpn);
shop.post('/payments/sslcommerz/fail', orders.sslFailOrCancel('failed'));
shop.post('/payments/sslcommerz/cancel', orders.sslFailOrCancel('cancelled'));

shop.get('/categories', products.categories);
shop.get('/products', products.list);
shop.get('/products/:id', products.get);
shop.post('/products', requireUser, products.create);
shop.patch('/products/:id', requireUser, products.update);
shop.delete('/products/:id', requireUser, products.remove);

shop.post('/inventory/reap', requireRole('admin'), inventory.reap);
shop.get('/inventory/:productId', requireUser, inventory.get);
shop.put('/inventory/:productId', requireUser, inventory.set);

shop.post('/orders', requireUser, orders.create);
shop.get('/orders', requireUser, orders.list);
shop.get('/orders/:id', requireUser, orders.get);
shop.post('/orders/:id/pay', requireUser, orders.pay);
shop.post('/orders/:id/cancel', requireUser, orders.cancel);

app.use('/api/v1/shop', shop);

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    req.log.error({ err }, 'Error after headers were sent');
    res.end();
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof LockTimeoutError) {
    res.status(409).json({ error: { code: 'busy', message: 'The resource is busy, please retry' } });
    return;
  }
  const parseFailure = err as { type?: string };
  if (parseFailure.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    return;
  }
  if (parseFailure.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
    return;
  }
  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
});

// Background job: return unpaid reservations to the pool. Only one instance runs it at a time.
const reaper = setInterval(() => {
  locks
    .tryLock('job:reaper', 25_000, () => inventory.reapExpired())
    .then((released) => {
      if (released && released.length > 0) logger.info({ count: released.length }, 'Released expired reservations');
    })
    .catch((err: unknown) => logger.error({ err }, 'Reservation reaper failed'));
}, 30_000);
reaper.unref();

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info({ port: env.PORT }, 'ecommerce-service listening');
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn({ signal }, 'Shutting down');
  clearInterval(reaper);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(() => {
    redis
      .quit()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
