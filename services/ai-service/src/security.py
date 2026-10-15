"""Authentication, rate limiting and concurrency control."""

import logging
import time
from collections import defaultdict
from dataclasses import dataclass
from uuid import UUID

import jwt
import redis.asyncio as aioredis
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from src.config import settings

log = logging.getLogger("ai-service.security")


@dataclass(slots=True)
class AuthUser:
    id: str
    email: str | None


_bearer = HTTPBearer(auto_error=False)


def _unauthorized(message: str) -> HTTPException:
    return HTTPException(status_code=401, detail=message, headers={"WWW-Authenticate": "Bearer"})


async def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> AuthUser:
    if credentials is None or not credentials.credentials:
        raise _unauthorized("Missing bearer token")
    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
            options={"require": ["exp", "sub"]},
            leeway=5,
        )
    except jwt.ExpiredSignatureError:
        raise _unauthorized("Access token expired") from None
    except jwt.PyJWTError:
        raise _unauthorized("Invalid access token") from None
    try:
        user_id = str(UUID(str(payload["sub"])))
    except ValueError:
        raise _unauthorized("Invalid access token") from None
    return AuthUser(id=user_id, email=payload.get("email"))


class RateLimiter:
    """Fixed-window limiter. Uses Redis when configured, otherwise per-process memory."""

    def __init__(self, redis_client: aioredis.Redis | None, limit: int, window_seconds: int = 60) -> None:
        self._redis = redis_client
        self._limit = limit
        self._window = window_seconds
        self._local: dict[str, tuple[int, int]] = {}

    async def hit(self, key: str) -> tuple[bool, int]:
        now = int(time.time())
        bucket = now // self._window
        retry_after = self._window - (now % self._window)
        if self._redis is not None:
            redis_key = f"rl:ai:{key}:{bucket}"
            try:
                pipe = self._redis.pipeline(transaction=True)
                pipe.incr(redis_key)
                pipe.expire(redis_key, self._window + 5)
                count, _ = await pipe.execute()
                return int(count) <= self._limit, retry_after
            except Exception as exc:  # fail open: an outage must not take the AI feature down
                log.warning("rate limiter redis error, failing open: %s", exc)
                return True, retry_after
        last_bucket, count = self._local.get(key, (bucket, 0))
        count = count + 1 if last_bucket == bucket else 1
        self._local[key] = (bucket, count)
        if len(self._local) > 50_000:
            self._local = {k: v for k, v in self._local.items() if v[0] == bucket}
        return count <= self._limit, retry_after


class SlotLease:
    def __init__(self, slots: "StreamSlots", user_id: str) -> None:
        self._slots = slots
        self._user_id = user_id
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._slots.release(self._user_id)


class StreamSlots:
    """Caps concurrent generations per user (per process)."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active: dict[str, int] = defaultdict(int)

    def acquire(self, user_id: str) -> SlotLease:
        if self._active[user_id] >= self._limit:
            raise HTTPException(status_code=429, detail="Too many concurrent AI requests", headers={"Retry-After": "5"})
        self._active[user_id] += 1
        return SlotLease(self, user_id)

    def release(self, user_id: str) -> None:
        remaining = self._active[user_id] - 1
        if remaining <= 0:
            self._active.pop(user_id, None)
        else:
            self._active[user_id] = remaining


async def guard(request: Request, user: AuthUser = Depends(current_user)) -> AuthUser:
    allowed, retry_after = await request.app.state.limiter.hit(user.id)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded, slow down",
            headers={"Retry-After": str(retry_after)},
        )
    return user


