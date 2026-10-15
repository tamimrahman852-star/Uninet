/**
 * Uninet auth-service - Express + Supabase Auth.
 *
 * Endpoints (all under /api/v1/auth):
 *   POST   /register | /login | /refresh | /logout
 *   POST   /password/forgot | /password/reset
 *   POST   /otp/send | /otp/verify
 *   GET    /me          PATCH /me
 *   GET    /healthz, /readyz  (outside the prefix)
 */
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { env, logger } from './config';
import { AuthController, createRequireAuth } from './controllers/auth.controller';
import { UserController } from './controllers/user.controller';
import { SupabaseService } from './services/supabase.service';
import { asyncHandler, HttpError } from './utils/http';

const supabase = new SupabaseService();
const authController = new AuthController(supabase);
const userController = new UserController(supabase);
const requireAuth = createRequireAuth(supabase);

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts, try again later' } });
  },
});

const router = express.Router();
router.post('/register', sensitiveLimiter, authController.register);
router.post('/login', sensitiveLimiter, authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', requireAuth, authController.logout);
router.post('/password/forgot', sensitiveLimiter, authController.forgotPassword);
router.post('/password/reset', sensitiveLimiter, requireAuth, authController.resetPassword);
router.post('/otp/send', sensitiveLimiter, authController.sendOtp);
router.post('/otp/verify', sensitiveLimiter, authController.verifyOtp);
router.get('/me', requireAuth, userController.me);
router.patch('/me', requireAuth, userController.updateMe);

const app = express();
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.disable('x-powered-by');

app.use(pinoHttp({ logger, genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID() }));
app.use(helmet());

const allowedOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : env.NODE_ENV !== 'production', credentials: true, maxAge: 600 }));

// Defence in depth; the gateway already applies distributed per-user limits.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path === '/healthz' || req.path === '/readyz',
  }),
);
app.use(express.json({ limit: '32kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get(
  '/readyz',
  asyncHandler(async (_req, res) => {
    if (!(await supabase.ping())) {
      res.status(503).json({ status: 'unavailable' });
      return;
    }
    res.json({ status: 'ok' });
  }),
);

app.use('/api/v1/auth', router);

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
        message: 'Invalid request body',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
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

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info({ port: env.PORT }, 'auth-service listening');
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error while closing server');
      process.exit(1);
    }
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
