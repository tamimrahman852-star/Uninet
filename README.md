# Uninet

One app that combines a Facebook-style feed, WhatsApp/Telegram-style encrypted chat, a Daraz/Amazon-style
marketplace, YouTube-style video, and a ChatGPT-style assistant.

```
Clients (Next.js 14 web, Flutter mobile)
        |  HTTPS / WSS / SSE
        v
 api-gateway (NestJS)  --- routing, JWT pre-validation, Redis rate limits, WS proxy
        |
        +-- auth-service       Node/Express + Supabase Auth
        +-- chat-service       Go, WebSockets, Redis backplane, Cassandra history
        +-- ecommerce-service  Node, Redis flash-sale stock reservation, Stripe / bKash / SSLCommerz
        +-- media-service      Python FastAPI, ffmpeg ABR HLS, OpenCV thumbnails, S3
        +-- ai-service         Python FastAPI, SSE streaming, Anthropic / OpenAI-compatible / vLLM, pgvector RAG
 The social feed (posts, stories) talks to Supabase directly from the clients (Row Level Security).
```

## Repository layout

The folder structure follows the specification you gave. A few small helper files were added where the code needs
them (`.env.example` files, `tsconfig.json`, SQL schemas, `config`/`utils` modules). Everything else is in the
requested place.

| Path | What it is |
| --- | --- |
| `api-gateway/` | NestJS gateway (`src/proxy/routes.proxy.ts` holds the route table) |
| `services/auth-service/` | Express + Supabase Auth (`supabase/schema.sql`) |
| `services/chat-service/` | Go chat relay (`internal/protocol`, `internal/storage`, `internal/handler`, `internal/hub.go`) |
| `services/ecommerce-service/` | Marketplace, orders, inventory, payments (`supabase/schema.sql`) |
| `services/media-service/` | Upload, transcoding, catalogue (`schema.sql`) |
| `services/ai-service/` | LLM streaming, history, RAG (`schema.sql`) |
| `frontend-web/` | Next.js 14 (App Router, Tailwind, Zustand) |
| `mobile-app/` | Flutter (flutter_bloc, Dio) |
| `infra/` | Dockerfiles, `docker-compose.yml`, Terraform (AWS ECS Fargate), `supabase/feed_schema.sql` |
| `.github/workflows/` | CI/CD for web, mobile and backend |

## Quick start (local, Docker)

1. Create a Supabase project. In the SQL editor run, **in this order**:
   1. `services/auth-service/supabase/schema.sql`
   2. `infra/supabase/feed_schema.sql`
   3. `services/ecommerce-service/supabase/schema.sql`
   4. `services/media-service/schema.sql`
   5. `services/ai-service/schema.sql` (enables `pgvector`; change `vector(1536)` if you use another embedding size)
2. `cp .env.example .env` and fill in the Supabase URL/keys, the **legacy JWT secret** (Settings, API), an LLM key,
   and (optionally) payment and S3 credentials.
3. `docker compose up --build` (Compose v2.20+). The gateway is on <http://localhost:8080>.
4. Web: `cd frontend-web && cp .env.example .env.local && npm install && npm run dev`.
5. Mobile:
   ```bash
   cd mobile-app
   flutter create . --platforms=android,ios      # generates the android/ and ios/ folders
   flutter pub get
   flutter run \
     --dart-define=API_URL=http://10.0.2.2:8080 --dart-define=WS_URL=ws://10.0.2.2:8080 \
     --dart-define=SUPABASE_URL=https://YOUR.supabase.co --dart-define=SUPABASE_ANON_KEY=...
   ```
   Android: add `<uses-permission android:name="android.permission.INTERNET"/>` (already in debug) and, for plain
   HTTP development, `android:usesCleartextTraffic="true"`. iOS: add `NSPhotoLibraryUsageDescription` to `Info.plist`.

Optional self-hosted inference with vLLM (needs an NVIDIA GPU): `docker compose --profile vllm up`, then set
`LLM_PROVIDER=openai`, `LLM_BASE_URL=http://vllm:8000/v1`, `LLM_MODEL=<model id>`. PagedAttention, continuous batching
and prefix caching happen inside vLLM.

Make a user a seller or admin by setting `app_metadata.role` (`seller` / `admin`) on the Supabase user. With
`OPEN_SELLER_REGISTRATION=true` (default) any signed-in user can list products.

## Service ports and API prefixes

| Service | Port | Gateway prefix |
| --- | --- | --- |
| api-gateway | 8080 | (public entrypoint) |
| auth-service | 4001 | `/api/v1/auth` |
| chat-service | 4002 | `/api/v1/chat` (`/ws` WebSocket) |
| ecommerce-service | 4003 | `/api/v1/shop` |
| media-service | 4004 | `/api/v1/media` |
| ai-service | 4005 | `/api/v1/ai` |

Health endpoints: `/healthz` and `/readyz` on every service; the gateway `/readyz` aggregates them.

## Design notes

- **Auth**: Supabase Auth issues HS256 JWTs. The gateway verifies them, strips any client-supplied `x-user-*`
  headers and forwards trusted ones plus `x-gateway-secret`. The chat, media and AI services also verify the JWT
  themselves. If your Supabase project uses asymmetric signing keys, swap the verifier for a JWKS one.
- **Chat**: the server only relays opaque ciphertext. Clients use ECDSA P-256 identity keys, ECDH P-256 signed
  prekeys, HKDF-SHA256 and AES-256-GCM (identical on web and mobile). Messages are stored as ciphertext in Cassandra;
  offline delivery and multi-instance fan-out use Redis. A compact binary frame codec (`internal/protocol/mtproto.go`)
  is available with `?proto=binary`.
- **Flash-sale stock**: reserving all lines of an order is a single Redis Lua script (no overselling); unpaid
  reservations are returned by a reaper job; the DB function `confirm_order` commits stock atomically and idempotently.
- **Video**: resumable chunked upload, one ffmpeg process producing a 360p to 4K ladder (never upscaling), HLS
  master playlist, thumbnails via OpenCV, objects in S3 (or the Supabase Storage S3 endpoint).

## Known limitations (read before production)

- **Not everything was executed.** Verified in the build environment: TypeScript type-checks (gateway, auth,
  ecommerce, web), `next build` of the web app, Python compile/import of the AI and media services, and the generated
  ffmpeg command. **Not compiled or run here:** the Go chat service (no Go toolchain), the Flutter app (no SDK),
  Terraform (`terraform validate`), all SQL, and every payment provider integration (use each provider's sandbox).
  Run `go mod tidy && go vet ./...`, `flutter analyze`, and `terraform validate` first.
- The chat E2EE is a simplified scheme: no Double Ratchet, so no forward secrecy beyond signed-prekey rotation.
  The "MTProto-style" binary codec is a custom framing format, **not** Telegram's MTProto. Use libsignal for
  Signal-level guarantees. Plaintext history is stored on the device (localStorage / SharedPreferences).
- The "ZKP" schema mentioned in the original tree is **not implemented**.
- Media transcoding runs in-process (a queue with a worker). For high volume move it to SQS or Celery workers.
- Payment callbacks redirect to the web frontend URL; mobile deep-link return is not wired up.
- No automated tests are included. Add integration tests around the payment and stock flows first.

## CI/CD

- `ci-cd-web.yml`: typecheck, lint, build, deploy to Vercel (`VERCEL_*` secrets).
- `ci-cd-mobile.yml`: analyze, build AAB and unsigned iOS (`SUPABASE_*` secrets, `API_URL`/`WS_URL` variables).
- `backend-deploy.yml`: tests, build and push six images to ECR, register a new ECS task definition, deploy
  (`AWS_DEPLOY_ROLE_ARN` secret, OIDC). Provision the infrastructure first with `infra/terraform`.
