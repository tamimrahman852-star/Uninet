"""LLM inference providers with streaming.

Two wire protocols are supported:
  - AnthropicProvider: Anthropic Messages API (server-sent events)
  - OpenAICompatibleProvider: OpenAI chat completions, which is also what vLLM, Ollama and llama.cpp expose.

Self-hosting with vLLM gives you PagedAttention (KV-cache paging), continuous batching and prefix caching on the
server side; this service just streams from it. Recommended launch flags:
  vllm serve <model> --enable-prefix-caching --gpu-memory-utilization 0.90 --max-num-seqs 128 --max-model-len 8192
and then LLM_PROVIDER=openai LLM_BASE_URL=http://<host>:8000/v1 LLM_MODEL=<model>.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol

import httpx

from src.config import settings

log = logging.getLogger("ai-service.inference")


@dataclass(slots=True)
class LLMRequest:
    model: str
    system: str
    messages: list[dict[str, str]]
    temperature: float | None
    max_tokens: int


@dataclass(slots=True)
class StreamChunk:
    text: str = ""
    input_tokens: int | None = None
    output_tokens: int | None = None
    stop_reason: str | None = None


class UpstreamError(Exception):
    def __init__(self, status: int, code: str, public_message: str) -> None:
        super().__init__(public_message)
        self.status = status
        self.code = code
        self.public_message = public_message


def _upstream_error(status: int, body: bytes) -> UpstreamError:
    log.error("LLM provider returned %s: %s", status, body[:500].decode("utf-8", errors="replace"))
    if status == 429:
        return UpstreamError(status, "provider_rate_limited", "The AI provider is busy, please retry shortly")
    if status in (401, 403):
        return UpstreamError(502, "provider_auth", "The AI provider rejected the service credentials")
    if status == 400:
        return UpstreamError(status, "provider_bad_request", "The AI provider rejected this request")
    if status == 529 or status >= 500:
        return UpstreamError(503, "provider_unavailable", "The AI provider is temporarily unavailable")
    return UpstreamError(502, "provider_error", "The AI provider returned an unexpected error")


async def iter_sse(response: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    """Parse a text/event-stream response into (event, data) tuples."""
    event = "message"
    data_lines: list[str] = []
    async for line in response.aiter_lines():
        if line == "":
            if data_lines:
                yield event, "\n".join(data_lines)
            event, data_lines = "message", []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
    if data_lines:
        yield event, "\n".join(data_lines)


class AnthropicProvider:
    def __init__(self, client: httpx.AsyncClient, api_key: str, base_url: str | None) -> None:
        self._client = client
        self._api_key = api_key
        self._base = (base_url or "https://api.anthropic.com").rstrip("/")

    async def stream(self, req: LLMRequest) -> AsyncIterator[StreamChunk]:
        payload: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens,
            "system": req.system,
            "messages": req.messages,
            "stream": True,
        }
        if req.temperature is not None:
            payload["temperature"] = min(req.temperature, 1.0)
        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "accept": "text/event-stream",
        }
        async with self._client.stream("POST", f"{self._base}/v1/messages", json=payload, headers=headers) as resp:
            if resp.status_code != 200:
                raise _upstream_error(resp.status_code, await resp.aread())
            async for _event, data in iter_sse(resp):
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    log.warning("skipping malformed provider event")
                    continue
                kind = obj.get("type")
                if kind == "content_block_delta":
                    delta = obj.get("delta", {})
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        yield StreamChunk(text=delta["text"])
                elif kind == "message_start":
                    usage = obj.get("message", {}).get("usage", {})
                    yield StreamChunk(input_tokens=usage.get("input_tokens"), output_tokens=usage.get("output_tokens"))
                elif kind == "message_delta":
                    usage = obj.get("usage", {})
                    yield StreamChunk(
                        output_tokens=usage.get("output_tokens"),
                        stop_reason=obj.get("delta", {}).get("stop_reason"),
                    )
                elif kind == "error":
                    err = obj.get("error", {})
                    log.error("provider stream error: %s", err)
                    raise UpstreamError(503, "provider_unavailable", "The AI provider interrupted the response")
                elif kind == "message_stop":
                    break


class OpenAICompatibleProvider:
    def __init__(self, client: httpx.AsyncClient, api_key: str, base_url: str | None) -> None:
        self._client = client
        self._api_key = api_key
        self._base = (base_url or "https://api.openai.com/v1").rstrip("/")

    async def stream(self, req: LLMRequest) -> AsyncIterator[StreamChunk]:
        payload: dict[str, Any] = {
            "model": req.model,
            "messages": [{"role": "system", "content": req.system}, *req.messages],
            "max_tokens": req.max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if req.temperature is not None:
            payload["temperature"] = req.temperature
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
            "accept": "text/event-stream",
        }
        async with self._client.stream("POST", f"{self._base}/chat/completions", json=payload, headers=headers) as resp:
            if resp.status_code != 200:
                raise _upstream_error(resp.status_code, await resp.aread())
            async for _event, data in iter_sse(resp):
                if data.strip() == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    log.warning("skipping malformed provider event")
                    continue
                usage = obj.get("usage")
                if usage:
                    yield StreamChunk(
                        input_tokens=usage.get("prompt_tokens"),
                        output_tokens=usage.get("completion_tokens"),
                    )
                for choice in obj.get("choices") or []:
                    text = (choice.get("delta") or {}).get("content")
                    finish = choice.get("finish_reason")
                    if text or finish:
                        yield StreamChunk(text=text or "", stop_reason=finish)


class LLMProvider(Protocol):
    def stream(self, req: LLMRequest) -> AsyncIterator[StreamChunk]: ...


def build_provider(client: httpx.AsyncClient) -> "AnthropicProvider | OpenAICompatibleProvider":
    """Create the provider selected by LLM_PROVIDER."""
    if settings.llm_provider == "anthropic":
        return AnthropicProvider(client, settings.llm_api_key, settings.llm_base_url)
    return OpenAICompatibleProvider(client, settings.llm_api_key, settings.llm_base_url)
