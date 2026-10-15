"""Runtime configuration for the media service."""

import logging

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 4004
    log_level: str = "INFO"
    cors_origins: str = ""

    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    s3_endpoint_url: str | None = None
    s3_region: str = "ap-southeast-1"
    s3_bucket: str
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    media_public_base_url: str | None = None

    work_dir: str = "/tmp/uninet-media"
    max_upload_bytes: int = 4 * 1024 * 1024 * 1024
    default_chunk_bytes: int = 8 * 1024 * 1024
    max_chunk_bytes: int = 32 * 1024 * 1024
    max_duration_seconds: int = 4 * 60 * 60
    max_concurrent_transcodes: int = 1
    ffmpeg_preset: str = "veryfast"
    ffmpeg_timeout_seconds: int = 6 * 60 * 60


settings = Settings()  # type: ignore[call-arg]

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
