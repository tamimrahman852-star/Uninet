"""Uninet media-service: resumable video upload, adaptive-bitrate HLS transcoding, catalogue, likes, comments.

Upload flow (all under /api/v1/media):
    POST   /uploads                          {title, description, filename, size_bytes, content_type}
    PUT    /uploads/{id}/chunks/{index}      raw bytes of one chunk (resumable, idempotent)
    GET    /uploads/{id}                     which chunks arrived (use to resume)
    POST   /uploads/{id}/complete            assemble + queue transcoding
Catalogue:
    GET    /videos, /videos/{id}, /stream/{id}/master.m3u8 (redirect to the CDN playlist)
    POST   /videos/{id}/view | POST,DELETE /videos/{id}/like | DELETE /videos/{id}
    GET,POST /videos/{id}/comments | DELETE /videos/{id}/comments/{comment_id}
"""

import asyncio
import json
import logging
import math
import os
import re
import shutil
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from src.auth import AuthUser, optional_user, require_user
from src.config import settings
from src.encoder.transcoder import TranscodeError, extract_thumbnail, probe, select_renditions, transcode_hls
from src.store import VideoStore
from src.uploader.s3_uploader import MultipartUploader, S3Uploader

log = logging.getLogger("media")

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


# --------------------------------------------------------------------------- #
# Upload state on local disk (survives restarts; the worker recovers assembled uploads)
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class UploadMeta:
    upload_id: str
    video_id: str
    user_id: str
    filename: str
    extension: str
    size_bytes: int
    chunk_size: int
    total_chunks: int
    state: str  # uploading | assembled | processing

    @classmethod
    def load(cls, path: Path) -> "UploadMeta":
        return cls(**json.loads(path.read_text()))

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.__dict__))
        os.replace(tmp, path)


def uploads_root() -> Path:
    return Path(settings.work_dir) / "uploads"


def upload_dir(upload_id: str) -> Path:
    if not UUID_RE.match(upload_id):
        raise HTTPException(status_code=404, detail="Upload not found")
    return uploads_root() / upload_id


def load_meta(upload_id: str, user: AuthUser) -> tuple[Path, UploadMeta]:
    directory = upload_dir(upload_id)
    meta_path = directory / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Upload not found")
    meta = UploadMeta.load(meta_path)
    if meta.user_id != user.id:
        raise HTTPException(status_code=404, detail="Upload not found")
    return directory, meta


def expected_chunk_size(meta: UploadMeta, index: int) -> int:
    if index < meta.total_chunks - 1:
        return meta.chunk_size
    return meta.size_bytes - meta.chunk_size * (meta.total_chunks - 1)


def received_chunks(directory: Path, meta: UploadMeta) -> list[int]:
    parts = directory / "parts"
    if not parts.exists():
        return []
    received = []
    for index in range(meta.total_chunks):
        part = parts / f"{index:06d}"
        if part.exists() and part.stat().st_size == expected_chunk_size(meta, index):
            received.append(index)
    return received


def assemble(directory: Path, meta: UploadMeta) -> Path:
    target = directory / f"source{meta.extension}"
    with target.open("wb") as out:
        for index in range(meta.total_chunks):
            with (directory / "parts" / f"{index:06d}").open("rb") as part:
                shutil.copyfileobj(part, out, length=4 * 1024 * 1024)
    shutil.rmtree(directory / "parts", ignore_errors=True)
    return target


# --------------------------------------------------------------------------- #
# Processing pipeline
# --------------------------------------------------------------------------- #


async def process_upload(app: FastAPI, upload_id: str) -> None:
    store: VideoStore = app.state.store
    storage: S3Uploader = app.state.storage
    directory = uploads_root() / upload_id
    meta = UploadMeta.load(directory / "meta.json")
    video_id = meta.video_id
    source = directory / f"source{meta.extension}"

    async def report(fraction: float) -> None:
        log.info("video %s transcoding %.0f%%", video_id, fraction * 100)

    try:
        meta.state = "processing"
        meta.save(directory / "meta.json")

        info = await probe(source)
        if info.duration > settings.max_duration_seconds:
            raise TranscodeError("The video is too long")

        renditions = select_renditions(info.height)
        hls_dir = directory / "hls"
        await transcode_hls(
            source,
            hls_dir,
            info,
            renditions,
            preset=settings.ffmpeg_preset,
            timeout=settings.ffmpeg_timeout_seconds,
            progress=report,
        )
        thumbnail = await extract_thumbnail(source, directory / "thumbnail.jpg", info.duration)

        prefix = f"videos/{video_id}"
        source_key = f"{prefix}/source{meta.extension}"
        await asyncio.to_thread(storage.upload_directory, hls_dir, f"{prefix}/hls")
        await asyncio.to_thread(storage.upload_file, thumbnail, f"{prefix}/thumbnail.jpg")
        await asyncio.to_thread(MultipartUploader(storage).upload, source, source_key)

        await store.update_video(
            video_id,
            {
                "status": "ready",
                "error": None,
                "duration_seconds": round(info.duration, 2),
                "width": info.width,
                "height": info.height,
                "renditions": [r.name for r in renditions],
                "hls_path": f"{prefix}/hls/master.m3u8",
                "thumbnail_path": f"{prefix}/thumbnail.jpg",
                "source_path": source_key,
            },
        )
        log.info("video %s is ready (%s)", video_id, [r.name for r in renditions])
    except TranscodeError as exc:
        log.warning("video %s failed: %s", video_id, exc)
        await store.update_video(video_id, {"status": "failed", "error": str(exc)})
    except Exception:  # noqa: BLE001 - never let one video kill the worker
        log.exception("video %s failed unexpectedly", video_id)
        await store.update_video(video_id, {"status": "failed", "error": "Processing failed, please try again"})
    finally:
        shutil.rmtree(directory, ignore_errors=True)


async def worker(app: FastAPI, name: str) -> None:
    queue: asyncio.Queue[str] = app.state.queue
    while True:
        upload_id = await queue.get()
        try:
            await process_upload(app, upload_id)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("%s: unhandled error for upload %s", name, upload_id)
        finally:
            queue.task_done()


async def recover_assembled(app: FastAPI) -> None:
    root = uploads_root()
    if not root.exists():
        return
    for directory in root.iterdir():
        meta_path = directory / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = UploadMeta.load(meta_path)
        except (ValueError, TypeError):
            continue
        if meta.state in ("assembled", "processing") and (directory / f"source{meta.extension}").exists():
            log.info("recovering upload %s", meta.upload_id)
            await app.state.queue.put(meta.upload_id)


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    uploads_root().mkdir(parents=True, exist_ok=True)
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))
    app.state.http = http_client
    app.state.store = VideoStore(http_client, settings.supabase_url, settings.supabase_service_role_key)
    app.state.storage = S3Uploader(
        bucket=settings.s3_bucket,
        region=settings.s3_region,
        endpoint_url=settings.s3_endpoint_url,
        access_key_id=settings.s3_access_key_id,
        secret_access_key=settings.s3_secret_access_key,
        public_base_url=settings.media_public_base_url,
    )
    app.state.queue = asyncio.Queue()
    workers = [
        asyncio.create_task(worker(app, f"worker-{i}")) for i in range(max(1, settings.max_concurrent_transcodes))
    ]
    await recover_assembled(app)
    try:
        yield
    finally:
        for task in workers:
            task.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        await http_client.aclose()


app = FastAPI(title="Uninet Media Service", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)

_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        max_age=600,
    )


def error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return body


_CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "payload_too_large"}


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code, content=error_body(_CODES.get(exc.status_code, "error"), str(exc.detail)), headers=exc.headers
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    details = [{"path": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
    return JSONResponse(status_code=422, content=error_body("validation_error", "Invalid request", details))


@app.exception_handler(httpx.HTTPError)
async def httpx_exception_handler(_request: Request, exc: httpx.HTTPError) -> JSONResponse:
    log.error("database error: %s", exc)
    return JSONResponse(status_code=502, content=error_body("upstream_error", "A dependent service failed"))


class UploadInit(BaseModel):
    title: str = Field(min_length=1, max_length=150)
    description: str = Field(default="", max_length=5000)
    filename: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0)
    content_type: str = Field(default="video/mp4", max_length=100)
    chunk_size: int | None = Field(default=None, ge=1024 * 1024)


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


def public_video(row: dict[str, Any]) -> dict[str, Any]:
    base = settings.media_public_base_url.rstrip("/") if settings.media_public_base_url else None
    out = {k: v for k, v in row.items() if k not in ("source_path", "search")}
    out["hls_url"] = f"{base}/{row['hls_path']}" if base and row.get("hls_path") else None
    out["thumbnail_url"] = f"{base}/{row['thumbnail_path']}" if base and row.get("thumbnail_path") else None
    return out


def require_uuid(value: str, what: str = "Resource") -> str:
    if not UUID_RE.match(value):
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return value


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
async def readyz(request: Request) -> JSONResponse:
    try:
        ok = await request.app.state.store.ping()
    except httpx.HTTPError:
        ok = False
    return JSONResponse(status_code=200 if ok else 503, content={"status": "ok" if ok else "unavailable"})


# --------------------------------------------------------------------------- #
# Upload routes
# --------------------------------------------------------------------------- #


@app.post("/api/v1/media/uploads", status_code=201)
async def init_upload(body: UploadInit, request: Request, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    extension = Path(body.filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS or not body.content_type.startswith("video/"):
        raise HTTPException(status_code=422, detail="Unsupported video format")
    if body.size_bytes > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="The file is too large")

    chunk_size = min(body.chunk_size or settings.default_chunk_bytes, settings.max_chunk_bytes)
    total_chunks = math.ceil(body.size_bytes / chunk_size)
    upload_id, video_id = str(uuid.uuid4()), str(uuid.uuid4())

    await request.app.state.store.create_video(video_id, user.id, body.title.strip(), body.description.strip())

    directory = uploads_root() / upload_id
    (directory / "parts").mkdir(parents=True)
    UploadMeta(
        upload_id=upload_id,
        video_id=video_id,
        user_id=user.id,
        filename=Path(body.filename).name,
        extension=extension,
        size_bytes=body.size_bytes,
        chunk_size=chunk_size,
        total_chunks=total_chunks,
        state="uploading",
    ).save(directory / "meta.json")
    return {"upload_id": upload_id, "video_id": video_id, "chunk_size": chunk_size, "total_chunks": total_chunks}


@app.put("/api/v1/media/uploads/{upload_id}/chunks/{index}")
async def upload_chunk(upload_id: str, index: int, request: Request, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    directory, meta = load_meta(upload_id, user)
    if meta.state != "uploading":
        raise HTTPException(status_code=409, detail="Upload is already complete")
    if index < 0 or index >= meta.total_chunks:
        raise HTTPException(status_code=422, detail="Chunk index out of range")

    expected = expected_chunk_size(meta, index)
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) != expected:
        raise HTTPException(status_code=422, detail=f"Chunk must be exactly {expected} bytes")

    parts = directory / "parts"
    temp = parts / f"{index:06d}.{uuid.uuid4().hex}.tmp"
    written = 0
    try:
        with temp.open("wb") as handle:
            async for piece in request.stream():
                written += len(piece)
                if written > expected:
                    raise HTTPException(status_code=413, detail=f"Chunk must be exactly {expected} bytes")
                handle.write(piece)
        if written != expected:
            raise HTTPException(status_code=422, detail=f"Chunk must be exactly {expected} bytes")
        os.replace(temp, parts / f"{index:06d}")
    finally:
        temp.unlink(missing_ok=True)

    received = received_chunks(directory, meta)
    return {"index": index, "received_count": len(received), "total_chunks": meta.total_chunks}


@app.get("/api/v1/media/uploads/{upload_id}")
async def upload_status(upload_id: str, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    directory, meta = load_meta(upload_id, user)
    return {
        "upload_id": meta.upload_id,
        "video_id": meta.video_id,
        "state": meta.state,
        "chunk_size": meta.chunk_size,
        "total_chunks": meta.total_chunks,
        "received": received_chunks(directory, meta) if meta.state == "uploading" else list(range(meta.total_chunks)),
    }


@app.post("/api/v1/media/uploads/{upload_id}/complete", status_code=202)
async def complete_upload(upload_id: str, request: Request, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    directory, meta = load_meta(upload_id, user)
    if meta.state != "uploading":
        raise HTTPException(status_code=409, detail="Upload is already complete")
    missing = sorted(set(range(meta.total_chunks)) - set(received_chunks(directory, meta)))
    if missing:
        raise HTTPException(status_code=409, detail=f"Missing chunks: {missing[:20]}")

    await asyncio.to_thread(assemble, directory, meta)
    meta.state = "assembled"
    meta.save(directory / "meta.json")
    await request.app.state.store.update_video(meta.video_id, {"status": "processing"})
    await request.app.state.queue.put(meta.upload_id)
    return {"video_id": meta.video_id, "status": "processing"}


# --------------------------------------------------------------------------- #
# Catalogue routes
# --------------------------------------------------------------------------- #


@app.get("/api/v1/media/videos")
async def list_videos(
    request: Request,
    q: str | None = None,
    user_id: str | None = None,
    page: int = 1,
    page_size: int = 24,
    viewer: AuthUser | None = Depends(optional_user),
) -> dict[str, Any]:
    page, page_size = max(1, page), max(1, min(page_size, 60))
    if user_id:
        require_uuid(user_id, "User")
    q = q.strip()[:100] if q else None
    rows, total = await request.app.state.store.list_videos(q, user_id, "ready", page_size, (page - 1) * page_size)
    return {"items": [public_video(r) for r in rows], "page": page, "page_size": page_size, "total": total}


@app.get("/api/v1/media/videos/{video_id}")
async def get_video(video_id: str, request: Request, viewer: AuthUser | None = Depends(optional_user)) -> dict[str, Any]:
    video = await request.app.state.store.get_video(require_uuid(video_id, "Video"))
    is_owner = viewer is not None and video is not None and viewer.id == video["user_id"]
    if video is None or (video["status"] != "ready" and not is_owner):
        raise HTTPException(status_code=404, detail="Video not found")
    liked = await request.app.state.store.has_liked(video_id, viewer.id) if viewer else False
    return {"video": public_video(video), "liked_by_me": liked}


@app.get("/api/v1/media/stream/{video_id}/master.m3u8")
async def stream_master(video_id: str, request: Request) -> Response:
    video = await request.app.state.store.get_video(require_uuid(video_id, "Video"))
    if video is None or video["status"] != "ready" or not video.get("hls_path"):
        raise HTTPException(status_code=404, detail="Video not found")
    url = request.app.state.storage.public_url(video["hls_path"])
    if url is None:
        raise HTTPException(status_code=503, detail="Streaming CDN is not configured")
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "public, max-age=60"})


@app.post("/api/v1/media/videos/{video_id}/view", status_code=204)
async def record_view(video_id: str, request: Request) -> Response:
    await request.app.state.store.increment_view(require_uuid(video_id, "Video"))
    return Response(status_code=204)


@app.post("/api/v1/media/videos/{video_id}/like", status_code=204)
async def like_video(video_id: str, request: Request, user: AuthUser = Depends(require_user)) -> Response:
    await request.app.state.store.like(require_uuid(video_id, "Video"), user.id)
    return Response(status_code=204)


@app.delete("/api/v1/media/videos/{video_id}/like", status_code=204)
async def unlike_video(video_id: str, request: Request, user: AuthUser = Depends(require_user)) -> Response:
    await request.app.state.store.unlike(require_uuid(video_id, "Video"), user.id)
    return Response(status_code=204)


@app.delete("/api/v1/media/videos/{video_id}", status_code=204)
async def delete_video(video_id: str, request: Request, user: AuthUser = Depends(require_user)) -> Response:
    require_uuid(video_id, "Video")
    owner_filter = None if user.role == "admin" else user.id
    if not await request.app.state.store.delete_video(video_id, owner_filter):
        raise HTTPException(status_code=404, detail="Video not found")
    asyncio.create_task(asyncio.to_thread(request.app.state.storage.delete_prefix, f"videos/{video_id}/"))
    return Response(status_code=204)


@app.get("/api/v1/media/videos/{video_id}/comments")
async def list_comments(video_id: str, request: Request, page: int = 1, page_size: int = 30) -> dict[str, Any]:
    page, page_size = max(1, page), max(1, min(page_size, 100))
    items = await request.app.state.store.list_comments(require_uuid(video_id, "Video"), page_size, (page - 1) * page_size)
    return {"items": items, "page": page, "page_size": page_size}


@app.post("/api/v1/media/videos/{video_id}/comments", status_code=201)
async def add_comment(video_id: str, body: CommentIn, request: Request, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    comment = await request.app.state.store.add_comment(require_uuid(video_id, "Video"), user.id, body.body.strip())
    return {"comment": comment}


@app.delete("/api/v1/media/videos/{video_id}/comments/{comment_id}", status_code=204)
async def delete_comment(video_id: str, comment_id: str, request: Request, user: AuthUser = Depends(require_user)) -> Response:
    require_uuid(video_id, "Video")
    require_uuid(comment_id, "Comment")
    if not await request.app.state.store.delete_comment(comment_id, video_id, user.id):
        raise HTTPException(status_code=404, detail="Comment not found")
    return Response(status_code=204)


if __name__ == "__main__":
    uvicorn.run("src.main:app", host="0.0.0.0", port=settings.port, log_level=settings.log_level.lower(), proxy_headers=True)
