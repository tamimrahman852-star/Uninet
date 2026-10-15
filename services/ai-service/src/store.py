"""Conversation history persisted through Supabase PostgREST."""

import time
from typing import Any

import httpx


class ConversationStore:
    def __init__(self, client: httpx.AsyncClient, supabase_url: str, service_key: str) -> None:
        self._client = client
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        self._headers = {
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "content-type": "application/json",
        }

    async def create_conversation(self, user_id: str, title: str, model: str) -> str:
        resp = await self._client.post(
            f"{self._base}/ai_conversations",
            headers={**self._headers, "Prefer": "return=representation"},
            json={"user_id": user_id, "title": title, "model": model},
        )
        resp.raise_for_status()
        return str(resp.json()[0]["id"])

    async def owns(self, user_id: str, conversation_id: str) -> bool:
        resp = await self._client.get(
            f"{self._base}/ai_conversations",
            headers=self._headers,
            params={"id": f"eq.{conversation_id}", "user_id": f"eq.{user_id}", "select": "id"},
        )
        resp.raise_for_status()
        return bool(resp.json())

    async def add_messages(self, rows: list[dict[str, Any]]) -> None:
        resp = await self._client.post(f"{self._base}/ai_messages", headers=self._headers, json=rows)
        resp.raise_for_status()

    async def touch(self, conversation_id: str) -> None:
        resp = await self._client.patch(
            f"{self._base}/ai_conversations",
            headers=self._headers,
            params={"id": f"eq.{conversation_id}"},
            json={"updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
        )
        resp.raise_for_status()

    async def list_conversations(self, user_id: str, limit: int, offset: int) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{self._base}/ai_conversations",
            headers=self._headers,
            params={
                "user_id": f"eq.{user_id}",
                "select": "id,title,model,created_at,updated_at",
                "order": "updated_at.desc",
                "limit": str(limit),
                "offset": str(offset),
            },
        )
        resp.raise_for_status()
        return list(resp.json())

    async def list_messages(self, user_id: str, conversation_id: str, limit: int) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{self._base}/ai_messages",
            headers=self._headers,
            params={
                "conversation_id": f"eq.{conversation_id}",
                "user_id": f"eq.{user_id}",
                "select": "id,role,content,input_tokens,output_tokens,created_at",
                "order": "created_at.asc",
                "limit": str(limit),
            },
        )
        resp.raise_for_status()
        return list(resp.json())

    async def delete_conversation(self, user_id: str, conversation_id: str) -> bool:
        resp = await self._client.delete(
            f"{self._base}/ai_conversations",
            headers={**self._headers, "Prefer": "return=representation"},
            params={"id": f"eq.{conversation_id}", "user_id": f"eq.{user_id}"},
        )
        resp.raise_for_status()
        return bool(resp.json())

