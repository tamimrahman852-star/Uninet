"""Text chunking and embedding generation (any OpenAI-compatible /embeddings endpoint)."""

import logging
import re

import httpx

from src.config import settings

log = logging.getLogger("ai-service.embeddings")

_BATCH_SIZE = 64
_SENTENCE_END = re.compile(r"(?<=[.!?।])\s+")


def chunk_text(text: str, max_chars: int | None = None, overlap: int | None = None) -> list[str]:
    """Split text into overlapping chunks, preferring paragraph, then sentence boundaries."""
    max_chars = max_chars or settings.rag_chunk_chars
    overlap = settings.rag_chunk_overlap if overlap is None else overlap
    normalized = re.sub(r"[ \t]+", " ", text.replace("\r\n", "\n")).strip()
    if not normalized:
        return []

    units: list[str] = []
    for paragraph in re.split(r"\n{2,}", normalized):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) <= max_chars:
            units.append(paragraph)
            continue
        for sentence in _SENTENCE_END.split(paragraph):
            while len(sentence) > max_chars:  # a single enormous sentence: hard split
                units.append(sentence[:max_chars])
                sentence = sentence[max_chars:]
            if sentence.strip():
                units.append(sentence.strip())

    chunks: list[str] = []
    current = ""
    for unit in units:
        candidate = f"{current}\n\n{unit}" if current else unit
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append(current)
            tail = current[-overlap:] if overlap > 0 else ""
            current = f"{tail}\n\n{unit}".strip() if tail and len(tail) + len(unit) + 2 <= max_chars else unit
        else:
            current = unit
    if current:
        chunks.append(current)
    return chunks


class EmbeddingError(Exception):
    pass


class EmbeddingClient:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    @property
    def enabled(self) -> bool:
        return bool(settings.embedding_api_key) or "api.openai.com" not in settings.embedding_base_url

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed texts in batches; returns vectors in the same order."""
        if not texts:
            return []
        headers = {"content-type": "application/json"}
        if settings.embedding_api_key:
            headers["authorization"] = f"Bearer {settings.embedding_api_key}"
        url = f"{settings.embedding_base_url.rstrip('/')}/embeddings"

        vectors: list[list[float]] = []
        for start in range(0, len(texts), _BATCH_SIZE):
            batch = texts[start : start + _BATCH_SIZE]
            payload: dict[str, object] = {"model": settings.embedding_model, "input": batch}
            if settings.embedding_model.startswith("text-embedding-3"):
                payload["dimensions"] = settings.embedding_dimensions
            resp = await self._client.post(url, json=payload, headers=headers)
            if resp.status_code != 200:
                log.error("embedding provider returned %s: %s", resp.status_code, resp.text[:300])
                raise EmbeddingError("The embedding provider rejected the request")
            data = sorted(resp.json().get("data", []), key=lambda item: item["index"])
            if len(data) != len(batch):
                raise EmbeddingError("The embedding provider returned an unexpected number of vectors")
            for item in data:
                vector = item["embedding"]
                if len(vector) != settings.embedding_dimensions:
                    raise EmbeddingError(
                        f"Embedding has {len(vector)} dimensions, expected {settings.embedding_dimensions}"
                    )
                vectors.append(vector)
        return vectors
