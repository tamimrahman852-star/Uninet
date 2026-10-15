"""Uninet ai-service: LLM inference with Server-Sent-Events streaming, conversation history and RAG.

Endpoints (all under /api/v1/ai)
    POST   /chat/stream                          stream a completion as SSE (optional use_rag)
    POST   /chat                                 non-streaming completion
    GET    /models
    GET    /conversations, /conversations/{id}/messages     DELETE /conversations/{id}
    POST   /documents  GET /documents  DELETE /documents/{id}      (RAG knowledge base per user)
    GET    /healthz, /readyz

SSE events emitted by /chat/stream
    meta   {request_id, conversation_id, model, sources}
    token  {delta}
    usage  {input_tokens, output_tokens, stop_reason}
    done   {conversation_id}
    error  {code, message}
    (": ping" comment lines are sent while the model is silent, to keep proxies from closing the stream)
"""

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal
from uuid import UUID

import httpx
import redis.asyncio as aioredis
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from starlette.background import BackgroundTask
from starlette.exceptions import HTTPException as StarletteHTTPException

from src.config import MAX_TOTAL_CHARS, settings
from src.models.inference import LLMRequest, StreamChunk, UpstreamError, build_provider
from src.rag.embeddings import EmbeddingClient, EmbeddingError, chunk_text
from src.rag.vector_db import VectorStore
from src.security import AuthUser, RateLimiter, StreamSlots, current_user, guard
from src.store import ConversationStore

log = logging.getLogger("ai-service")



class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=32_000)


class ChatRequest(BaseModel):
    conversation_id: UUID | None = None
    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=100)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=8192)
    persist: bool = True
    use_rag: bool = False

    @model_validator(mode="after")
    def _validate_messages(self) -> "ChatRequest":
        if self.messages[0].role != "user":
            raise ValueError("the first message must have role 'user'")
        if self.messages[-1].role != "user":
            raise ValueError("the last message must have role 'user'")
        if sum(len(m.content) for m in self.messages) > MAX_TOTAL_CHARS:
            raise ValueError(f"conversation exceeds {MAX_TOTAL_CHARS} characters")
        return self


# --------------------------------------------------------------------------- #
# App wiring
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0),
        limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
    )
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True) if settings.redis_url else None

    store: ConversationStore | None = None
    vectors: VectorStore | None = None
    if settings.supabase_url and settings.supabase_service_role_key:
        store = ConversationStore(http_client, settings.supabase_url, settings.supabase_service_role_key)
        vectors = VectorStore(http_client, settings.supabase_url, settings.supabase_service_role_key)
    else:
        log.warning("Supabase not configured: conversation history and RAG are disabled")

    app.state.http = http_client
    app.state.redis = redis_client
    app.state.provider = build_provider(http_client)
    app.state.store = store
    app.state.vectors = vectors
    app.state.embeddings = EmbeddingClient(http_client)
    app.state.limiter = RateLimiter(redis_client, settings.rate_limit_per_minute)
    app.state.streams = StreamSlots(settings.max_concurrent_streams)
    try:
        yield
    finally:
        await http_client.aclose()
        if redis_client is not None:
            await redis_client.aclose()


app = FastAPI(title="Uninet AI Service", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)

_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        max_age=600,
    )


def error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return body


_STATUS_CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 429: "rate_limited"}


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = _STATUS_CODES.get(exc.status_code, "error")
    return JSONResponse(status_code=exc.status_code, content=error_body(code, str(exc.detail)), headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    details = [{"path": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
    return JSONResponse(status_code=422, content=error_body("validation_error", "Invalid request", details))


@app.exception_handler(UpstreamError)
async def upstream_exception_handler(_request: Request, exc: UpstreamError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=error_body(exc.code, exc.public_message))


@app.exception_handler(EmbeddingError)
async def embedding_exception_handler(_request: Request, exc: EmbeddingError) -> JSONResponse:
    return JSONResponse(status_code=502, content=error_body("embedding_error", str(exc)))


@app.exception_handler(httpx.HTTPError)
async def httpx_exception_handler(_request: Request, exc: httpx.HTTPError) -> JSONResponse:
    log.error("upstream HTTP error: %s", exc)
    return JSONResponse(status_code=502, content=error_body("upstream_error", "A dependent service failed"))


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def resolve_model(requested: str | None) -> str:
    if not requested or requested == settings.llm_model:
        return settings.llm_model
    if requested in settings.allowed_model_set:
        return requested
    raise HTTPException(status_code=400, detail=f"Model '{requested}' is not available")


def build_llm_request(body: ChatRequest, model: str, context: str | None = None) -> LLMRequest:
    system = settings.system_prompt
    if context:
        system += (
            "\n\nUse the following excerpts from the user's own documents when they are relevant. "
            "Cite the document title in brackets when you rely on one, and say so if the excerpts do not "
            "contain the answer.\n\n" + context
        )
    return LLMRequest(
        model=model,
        system=system,
        messages=[{"role": m.role, "content": m.content} for m in body.messages],
        temperature=body.temperature,
        max_tokens=min(body.max_tokens or settings.llm_max_output_tokens, settings.llm_max_output_tokens),
    )


async def retrieve_context(request: Request, user: AuthUser, body: ChatRequest) -> tuple[str | None, list[dict[str, Any]]]:
    """Embed the latest user message and fetch the most similar chunks of the user's documents."""
    vectors: VectorStore | None = request.app.state.vectors
    embeddings: EmbeddingClient = request.app.state.embeddings
    if not body.use_rag or vectors is None or not embeddings.enabled:
        return None, []
    query = body.messages[-1].content[:4000]
    [vector] = await embeddings.embed([query])
    matches = await vectors.search(user.id, vector, settings.rag_top_k, settings.rag_min_similarity)
    if not matches:
        return None, []
    context = "\n\n".join(f"[{m['title']}] {m['content']}" for m in matches)
    sources = [
        {"document_id": m["document_id"], "title": m["title"], "similarity": round(float(m["similarity"]), 3)}
        for m in matches
    ]
    return context, sources


async def prepare_conversation(request: Request, user: AuthUser, body: ChatRequest, model: str) -> str | None:
    """Create/verify the conversation and persist the newest user message. Returns the conversation id."""
    store: ConversationStore | None = request.app.state.store
    if store is None or not body.persist:
        return None
    last = body.messages[-1]
    if body.conversation_id is not None:
        conversation_id = str(body.conversation_id)
        if not await store.owns(user.id, conversation_id):
            raise HTTPException(status_code=404, detail="Conversation not found")
    else:
        title = " ".join(last.content.split())[:60] or "New chat"
        conversation_id = await store.create_conversation(user.id, title, model)
    await store.add_messages(
        [{"conversation_id": conversation_id, "user_id": user.id, "role": "user", "content": last.content}]
    )
    return conversation_id


async def persist_assistant(
    request_state: Any, user: AuthUser, conversation_id: str | None, text: str, usage: dict[str, Any]
) -> None:
    store: ConversationStore | None = request_state.store
    if store is None or conversation_id is None or not text:
        return
    try:
        await store.add_messages(
            [
                {
                    "conversation_id": conversation_id,
                    "user_id": user.id,
                    "role": "assistant",
                    "content": text,
                    "input_tokens": usage.get("input_tokens"),
                    "output_tokens": usage.get("output_tokens"),
                }
            ]
        )
        await store.touch(conversation_id)
    except httpx.HTTPError as exc:
        log.error("failed to persist assistant message: %s", exc)


def merge_usage(usage: dict[str, Any], chunk: StreamChunk) -> None:
    if chunk.input_tokens is not None:
        usage["input_tokens"] = chunk.input_tokens
    if chunk.output_tokens is not None:
        usage["output_tokens"] = chunk.output_tokens
    if chunk.stop_reason:
        usage["stop_reason"] = chunk.stop_reason


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
async def readyz(request: Request) -> JSONResponse:
    redis_client: aioredis.Redis | None = request.app.state.redis
    if redis_client is not None:
        try:
            await asyncio.wait_for(redis_client.ping(), timeout=2.0)
        except Exception:
            return JSONResponse(status_code=503, content={"status": "unavailable"})
    return JSONResponse(content={"status": "ok"})


@app.get("/api/v1/ai/models")
async def list_models(_user: AuthUser = Depends(current_user)) -> dict[str, Any]:
    return {"default": settings.llm_model, "models": sorted(settings.allowed_model_set)}


@app.post("/api/v1/ai/chat/stream")
async def chat_stream(body: ChatRequest, request: Request, user: AuthUser = Depends(guard)) -> StreamingResponse:
    model = resolve_model(body.model)
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    lease = request.app.state.streams.acquire(user.id)
    try:
        context, sources = await retrieve_context(request, user, body)
        conversation_id = await prepare_conversation(request, user, body, model)
    except BaseException:
        lease.release()
        raise

    provider = request.app.state.provider
    state = request.app.state
    llm_request = build_llm_request(body, model, context)

    async def event_stream() -> AsyncIterator[str]:
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=256)

        async def producer() -> None:
            try:
                async for chunk in provider.stream(llm_request):
                    await queue.put(("chunk", chunk))
                await queue.put(("end", None))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reported to the client as an SSE error event
                await queue.put(("error", exc))

        task = asyncio.create_task(producer())
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        parts: list[str] = []
        usage: dict[str, Any] = {}
        try:
            yield sse("meta", {"request_id": request_id, "conversation_id": conversation_id, "model": model, "sources": sources})
            while True:
                try:
                    kind, payload = await asyncio.wait_for(queue.get(), timeout=settings.sse_heartbeat_seconds)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if kind == "chunk":
                    chunk: StreamChunk = payload
                    merge_usage(usage, chunk)
                    if chunk.text:
                        parts.append(chunk.text)
                        yield sse("token", {"delta": chunk.text})
                elif kind == "error":
                    if isinstance(payload, UpstreamError):
                        code, message = payload.code, payload.public_message
                    elif isinstance(payload, httpx.TimeoutException):
                        code, message = "provider_timeout", "The AI provider timed out"
                    else:
                        log.exception("stream failed", exc_info=payload)
                        code, message = "internal_error", "The response could not be completed"
                    yield sse("error", {"code": code, "message": message})
                    return
                else:  # end
                    break
            await persist_assistant(state, user, conversation_id, "".join(parts), usage)
            yield sse("usage", usage)
            yield sse("done", {"conversation_id": conversation_id})
        finally:
            task.cancel()  # client disconnected or stream finished; stop reading from the provider
            lease.release()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
        background=BackgroundTask(lease.release),
    )


@app.post("/api/v1/ai/chat")
async def chat(body: ChatRequest, request: Request, user: AuthUser = Depends(guard)) -> dict[str, Any]:
    model = resolve_model(body.model)
    lease = request.app.state.streams.acquire(user.id)
    try:
        context, sources = await retrieve_context(request, user, body)
        conversation_id = await prepare_conversation(request, user, body, model)
        parts: list[str] = []
        usage: dict[str, Any] = {}
        async for chunk in request.app.state.provider.stream(build_llm_request(body, model, context)):
            merge_usage(usage, chunk)
            if chunk.text:
                parts.append(chunk.text)
        text = "".join(parts)
        await persist_assistant(request.app.state, user, conversation_id, text, usage)
    finally:
        lease.release()
    return {
        "conversation_id": conversation_id,
        "model": model,
        "message": {"role": "assistant", "content": text},
        "usage": usage,
        "sources": sources,
    }


def _require_store(request: Request) -> ConversationStore:
    store: ConversationStore | None = request.app.state.store
    if store is None:
        raise HTTPException(status_code=404, detail="Conversation history is not enabled")
    return store


@app.get("/api/v1/ai/conversations")
async def list_conversations(
    request: Request, limit: int = 30, offset: int = 0, user: AuthUser = Depends(guard)
) -> dict[str, Any]:
    store = _require_store(request)
    items = await store.list_conversations(user.id, max(1, min(limit, 100)), max(0, offset))
    return {"conversations": items}


@app.get("/api/v1/ai/conversations/{conversation_id}/messages")
async def list_messages(
    conversation_id: UUID, request: Request, limit: int = 200, user: AuthUser = Depends(guard)
) -> dict[str, Any]:
    store = _require_store(request)
    if not await store.owns(user.id, str(conversation_id)):
        raise HTTPException(status_code=404, detail="Conversation not found")
    items = await store.list_messages(user.id, str(conversation_id), max(1, min(limit, 500)))
    return {"messages": items}


@app.delete("/api/v1/ai/conversations/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: UUID, request: Request, user: AuthUser = Depends(guard)
) -> Response:
    store = _require_store(request)
    if not await store.delete_conversation(user.id, str(conversation_id)):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return Response(status_code=204)


class DocumentIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)
    source: str | None = Field(default=None, max_length=500)


def _require_vectors(request: Request) -> VectorStore:
    vectors: VectorStore | None = request.app.state.vectors
    if vectors is None or not request.app.state.embeddings.enabled:
        raise HTTPException(status_code=404, detail="Knowledge base is not enabled")
    return vectors


@app.post("/api/v1/ai/documents", status_code=201)
async def add_document(body: DocumentIn, request: Request, user: AuthUser = Depends(guard)) -> dict[str, Any]:
    """Chunk, embed and store a text document for retrieval-augmented chat."""
    vectors = _require_vectors(request)
    if len(body.content) > settings.max_document_chars:
        raise HTTPException(status_code=413, detail=f"Documents are limited to {settings.max_document_chars} characters")
    chunks = chunk_text(body.content)
    if not chunks:
        raise HTTPException(status_code=422, detail="The document has no text")

    embeddings: EmbeddingClient = request.app.state.embeddings
    vectors_list = await embeddings.embed(chunks)
    document_id = await vectors.create_document(user.id, body.title.strip(), body.source, len(body.content))
    try:
        await vectors.add_chunks(document_id, user.id, chunks, vectors_list)
    except httpx.HTTPError:
        await vectors.delete_document(user.id, document_id)
        raise
    return {"document_id": document_id, "chunks": len(chunks)}


@app.get("/api/v1/ai/documents")
async def list_documents(request: Request, limit: int = 30, offset: int = 0, user: AuthUser = Depends(guard)) -> dict[str, Any]:
    vectors = _require_vectors(request)
    return {"documents": await vectors.list_documents(user.id, max(1, min(limit, 100)), max(0, offset))}


@app.delete("/api/v1/ai/documents/{document_id}", status_code=204)
async def delete_document(document_id: UUID, request: Request, user: AuthUser = Depends(guard)) -> Response:
    vectors = _require_vectors(request)
    if not await vectors.delete_document(user.id, str(document_id)):
        raise HTTPException(status_code=404, detail="Document not found")
    return Response(status_code=204)


if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=settings.port,
        log_level=settings.log_level.lower(),
        proxy_headers=True,
        forwarded_allow_ips="*",
        timeout_keep_alive=75,
    )
