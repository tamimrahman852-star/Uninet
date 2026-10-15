"""S3-compatible object storage (AWS S3 or Supabase Storage's S3 endpoint).

- MultipartUploader: explicit chunked upload (used to archive large source files)
- S3Uploader: directory upload with correct content types / cache headers, deletes and public URLs
All boto3 calls are blocking; callers run them via asyncio.to_thread.
"""

import logging
import mimetypes
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
from botocore.config import Config

log = logging.getLogger("media.s3")

_CONTENT_TYPES = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}

_MIN_PART_BYTES = 5 * 1024 * 1024  # S3 minimum for every part except the last


def content_type_for(path: Path) -> str:
    return _CONTENT_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def cache_control_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".ts":
        return "public, max-age=31536000, immutable"
    if suffix == ".m3u8":
        return "public, max-age=300"
    if suffix in (".jpg", ".jpeg"):
        return "public, max-age=86400"
    return "private, max-age=0"


class S3Uploader:
    def __init__(
        self,
        bucket: str,
        region: str,
        endpoint_url: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        public_base_url: str | None = None,
    ) -> None:
        self.bucket = bucket
        self._public_base = public_base_url.rstrip("/") if public_base_url else None
        self.client = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=endpoint_url or None,
            aws_access_key_id=access_key_id or None,
            aws_secret_access_key=secret_access_key or None,
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 5, "mode": "standard"},
                s3={"addressing_style": "path" if endpoint_url else "auto"},
                max_pool_connections=32,
            ),
        )

    def public_url(self, key: str) -> str | None:
        return f"{self._public_base}/{key}" if self._public_base else None

    def upload_file(self, local_path: Path, key: str, content_type: str | None = None, cache_control: str | None = None) -> None:
        extra = {
            "ContentType": content_type or content_type_for(local_path),
            "CacheControl": cache_control or cache_control_for(local_path),
        }
        self.client.upload_file(str(local_path), self.bucket, key, ExtraArgs=extra)

    def upload_directory(self, local_dir: Path, prefix: str, workers: int = 8) -> int:
        """Upload every file below local_dir, keeping the relative layout. Playlists go last so players never
        see a playlist that points to segments that are not uploaded yet."""
        files = [p for p in local_dir.rglob("*") if p.is_file()]
        files.sort(key=lambda p: (p.suffix.lower() == ".m3u8", p.name == "master.m3u8", str(p)))
        segments = [p for p in files if p.suffix.lower() != ".m3u8"]
        playlists = [p for p in files if p.suffix.lower() == ".m3u8"]

        def put(path: Path) -> None:
            key = f"{prefix.rstrip('/')}/{path.relative_to(local_dir).as_posix()}"
            self.upload_file(path, key)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(put, segments))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(put, playlists))
        return len(files)

    def delete_prefix(self, prefix: str) -> int:
        deleted = 0
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            if objects:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objects, "Quiet": True})
                deleted += len(objects)
        return deleted


class MultipartUploader:
    """Chunked upload of one large file with explicit part management and abort-on-failure."""

    def __init__(self, uploader: S3Uploader, part_size: int = 16 * 1024 * 1024) -> None:
        self._uploader = uploader
        self._part_size = max(part_size, _MIN_PART_BYTES)

    def upload(self, local_path: Path, key: str, content_type: str | None = None) -> None:
        client, bucket = self._uploader.client, self._uploader.bucket
        size = local_path.stat().st_size
        if size <= self._part_size:
            self._uploader.upload_file(local_path, key, content_type, "private, max-age=0")
            return

        created = client.create_multipart_upload(
            Bucket=bucket,
            Key=key,
            ContentType=content_type or content_type_for(local_path),
            CacheControl="private, max-age=0",
        )
        upload_id = created["UploadId"]
        parts: list[dict[str, object]] = []
        try:
            with local_path.open("rb") as handle:
                part_number = 1
                while True:
                    chunk = handle.read(self._part_size)
                    if not chunk:
                        break
                    response = client.upload_part(
                        Bucket=bucket, Key=key, UploadId=upload_id, PartNumber=part_number, Body=chunk
                    )
                    parts.append({"ETag": response["ETag"], "PartNumber": part_number})
                    part_number += 1
            client.complete_multipart_upload(
                Bucket=bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts}
            )
        except Exception:
            log.exception("multipart upload failed, aborting %s", key)
            client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            raise
