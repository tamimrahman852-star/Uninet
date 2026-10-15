"""Vector storage on Supabase Postgres (pgvector) via PostgREST + the match_documents RPC.

Schema lives in schema.sql (tables ai_documents / ai_document_chunks, function match_document_chunks).
"""

from typing import Any

import httpx


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{v:.7f}" for v in vector) + "]"


class VectorStore:
    def __init__(self, client: httpx.AsyncClient, supabase_url: str, service_key: str) -> None:
        self._client = client
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        self._headers = {
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "content-type": "application/json",
        }

    async def create_document(self, user_id: str, title: str, source: str | None, char_count: int) -> str:
        resp = await self._client.post(
            f"{self._base}/ai_documents",
            headers={**self._headers, "Prefer": "return=representation"},
            json={"user_id": user_id, "title": title, "source": source, "char_count": char_count},
        )
        resp.raise_for_status()
        return str(resp.json()[0]["id"])

    async def add_chunks(self, document_id: str, user_id: str, chunks: list[str], vectors: list[list[float]]) -> None:
        rows = [
            {
                "document_id": document_id,
                "user_id": user_id,
                "chunk_index": index,
                "content": content,
                "embedding": _vector_literal(vector),
            }
            for index, (content, vector) in enumerate(zip(chunks, vectors, strict=True))
        ]
        for start in range(0, len(rows), 200):
            resp = await self._client.post(f"{self._base}/ai_document_chunks", headers=self._headers, json=rows[start : start + 200])
            resp.raise_for_status()

    async def search(self, user_id: str, query_vector: list[float], top_k: int, min_similarity: float) -> list[dict[str, Any]]:
        resp = await self._client.post(
            f"{self._base}/rpc/match_document_chunks",
            headers=self._headers,
            json={
                "p_user_id": user_id,
                "p_query_embedding": _vector_literal(query_vector),
                "p_match_count": top_k,
                "p_min_similarity": min_similarity,
            },
        )
        resp.raise_for_status()
        return list(resp.json())

    async def list_documents(self, user_id: str, limit: int, offset: int) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{self._base}/ai_documents",
            headers=self._headers,
            params={
                "user_id": f"eq.{user_id}",
                "select": "id,title,source,char_count,created_at",
                "order": "created_at.desc",
                "limit": str(limit),
                "offset": str(offset),
            },
        )
        resp.raise_for_status()
        return list(resp.json())

    async def delete_document(self, user_id: str, document_id: str) -> bool:
        resp = await self._client.delete(
            f"{self._base}/ai_documents",
            headers={**self._headers, "Prefer": "return=representation"},
            params={"id": f"eq.{document_id}", "user_id": f"eq.{user_id}"},
        )
        resp.raise_for_status()
        return bool(resp.json())
