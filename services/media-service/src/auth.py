"""JWT authentication helpers (Supabase HS256 access tokens)."""

from dataclasses import dataclass
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from src.config import settings

_bearer = HTTPBearer(auto_error=False)


@dataclass(slots=True)
class AuthUser:
    id: str
    role: str


def _unauthorized(message: str) -> HTTPException:
    return HTTPException(status_code=401, detail=message, headers={"WWW-Authenticate": "Bearer"})


def _decode(token: str) -> AuthUser:
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
            options={"require": ["exp", "sub"]},
            leeway=5,
        )
        user_id = str(UUID(str(payload["sub"])))
    except jwt.ExpiredSignatureError:
        raise _unauthorized("Access token expired") from None
    except (jwt.PyJWTError, ValueError):
        raise _unauthorized("Invalid access token") from None
    role = (payload.get("app_metadata") or {}).get("role", "user")
    return AuthUser(id=user_id, role=str(role))


async def require_user(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> AuthUser:
    if credentials is None or not credentials.credentials:
        raise _unauthorized("Missing bearer token")
    return _decode(credentials.credentials)


async def optional_user(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> AuthUser | None:
    if credentials is None or not credentials.credentials:
        return None
    return _decode(credentials.credentials)
