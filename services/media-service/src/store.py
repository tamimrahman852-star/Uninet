"""Supabase PostgREST access for videos, likes and comments (service-role key, always filter by user)."""

from typing import Any

import httpx


class VideoStore:
    def __init__(self, client: httpx.AsyncClient, supabase_url: str, service_key: str) -> None:
        self._client = client
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        self._headers = {
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "content-type": "application/json",
        }

    def _repr(self) -> dict[str, str]:
        return {**self._headers, "Prefer": "return=representation"}

    async def ping(self) -> bool:
        resp = await self._client.get(f"{self._base}/videos", headers=self._headers, params={"select": "id", "limit": "1"})
        return resp.status_code == 200

    async def create_video(self, video_id: str, user_id: str, title: str, description: str) -> dict[str, Any]:
        resp = await self._client.post(
            f"{self._base}/videos",
            headers=self._repr(),
            json={"id": video_id, "user_id": user_id, "title": title, "description": description, "status": "uploading"},
        )
        resp.raise_for_status()
        return dict(resp.json()[0])

    async def update_video(self, video_id: str, fields: dict[str, Any]) -> None:
        resp = await self._client.patch(
            f"{self._base}/videos",
            headers=self._headers,
            params={"id": f"eq.{video_id}"},
            json={**fields, "updated_at": "now()"},
        )
        resp.raise_for_status()

    async def get_video(self, video_id: str) -> dict[str, Any] | None:
        resp = await self._client.get(
            f"{self._base}/videos",
            headers=self._headers,
            params={"id": f"eq.{video_id}", "select": "*,author:profiles!videos_user_id_fkey(username,full_name,avatar_url)"},
        )
        if resp.status_code >= 400:
            # profiles FK hint may be missing: retry without the embedded author
            resp = await self._client.get(
                f"{self._base}/videos", headers=self._headers, params={"id": f"eq.{video_id}", "select": "*"}
            )
        resp.raise_for_status()
        rows = resp.json()
        return dict(rows[0]) if rows else None

    async def list_videos(
        self, q: str | None, user_id: str | None, status: str, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        params: dict[str, str] = {
            "select": "id,user_id,title,description,status,duration_seconds,thumbnail_path,hls_path,view_count,like_count,comment_count,created_at",
            "status": f"eq.{status}",
            "order": "created_at.desc",
            "limit": str(limit),
            "offset": str(offset),
        }
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        if q:
            params["search"] = f"wfts(simple).{q}"
        headers = {**self._headers, "Prefer": "count=exact"}
        resp = await self._client.get(f"{self._base}/videos", headers=headers, params=params)
        resp.raise_for_status()
        total = int(resp.headers.get("content-range", "0/0").rsplit("/", 1)[-1] or 0)
        return list(resp.json()), total

    async def delete_video(self, video_id: str, user_id: str | None) -> bool:
        params = {"id": f"eq.{video_id}"}
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        resp = await self._client.delete(f"{self._base}/videos", headers=self._repr(), params=params)
        resp.raise_for_status()
        return bool(resp.json())

    async def increment_view(self, video_id: str) -> None:
        resp = await self._client.post(
            f"{self._base}/rpc/increment_video_view", headers=self._headers, json={"p_video_id": video_id}
        )
        resp.raise_for_status()

    async def like(self, video_id: str, user_id: str) -> None:
        resp = await self._client.post(
            f"{self._base}/video_likes",
            headers={**self._headers, "Prefer": "resolution=ignore-duplicates"},
            json={"video_id": video_id, "user_id": user_id},
        )
        resp.raise_for_status()

    async def unlike(self, video_id: str, user_id: str) -> None:
        resp = await self._client.delete(
            f"{self._base}/video_likes",
            headers=self._headers,
            params={"video_id": f"eq.{video_id}", "user_id": f"eq.{user_id}"},
        )
        resp.raise_for_status()

    async def has_liked(self, video_id: str, user_id: str) -> bool:
        resp = await self._client.get(
            f"{self._base}/video_likes",
            headers=self._headers,
            params={"video_id": f"eq.{video_id}", "user_id": f"eq.{user_id}", "select": "video_id"},
        )
        resp.raise_for_status()
        return bool(resp.json())

    async def list_comments(self, video_id: str, limit: int, offset: int) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{self._base}/video_comments",
            headers=self._headers,
            params={
                "video_id": f"eq.{video_id}",
                "select": "id,video_id,user_id,body,created_at,author:profiles(username,full_name,avatar_url)",
                "order": "created_at.desc",
                "limit": str(limit),
                "offset": str(offset),
            },
        )
        resp.raise_for_status()
        return list(resp.json())

    async def add_comment(self, video_id: str, user_id: str, body: str) -> dict[str, Any]:
        resp = await self._client.post(
            f"{self._base}/video_comments",
            headers=self._repr(),
            json={"video_id": video_id, "user_id": user_id, "body": body},
        )
        resp.raise_for_status()
        return dict(resp.json()[0])

    async def delete_comment(self, comment_id: str, video_id: str, user_id: str) -> bool:
        resp = await self._client.delete(
            f"{self._base}/video_comments",
            headers=self._repr(),
            params={"id": f"eq.{comment_id}", "video_id": f"eq.{video_id}", "user_id": f"eq.{user_id}"},
        )
        resp.raise_for_status()
        return bool(resp.json())
