"""Runtime configuration for the AI service."""

import logging
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 4005
    log_level: str = "INFO"
    cors_origins: str = ""

    supabase_jwt_secret: str
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None
    redis_url: str | None = None

    # LLM inference. "anthropic" uses the Messages API; "openai" speaks the OpenAI-compatible protocol
    # (OpenAI, vLLM, Ollama, llama.cpp server, ...). For self-hosted vLLM set LLM_PROVIDER=openai and
    # LLM_BASE_URL=http://vllm:8000/v1 (see infra/docker-compose.yml, profile "vllm").
    llm_provider: Literal["anthropic", "openai"] = "anthropic"
    llm_api_key: str
    llm_base_url: str | None = None
    llm_model: str = "claude-sonnet-5-5"
    allowed_models: str = ""
    llm_max_output_tokens: int = 4096
    system_prompt: str = (
        "You are Uninet Assistant, a helpful, accurate and concise AI assistant inside the Uninet app. "
        "If you are unsure, say so rather than guessing."
    )

    # RAG: embeddings come from any OpenAI-compatible /embeddings endpoint (OpenAI, vLLM, TEI, Ollama).
    embedding_api_key: str | None = None
    embedding_base_url: str = "https://api.openai.com/v1"
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    rag_top_k: int = 5
    rag_min_similarity: float = 0.2
    rag_chunk_chars: int = 1200
    rag_chunk_overlap: int = 150
    max_document_chars: int = 400_000

    rate_limit_per_minute: int = 20
    max_concurrent_streams: int = 3
    sse_heartbeat_seconds: float = 15.0

    @property
    def allowed_model_set(self) -> set[str]:
        return {m.strip() for m in self.allowed_models.split(",") if m.strip()} | {self.llm_model}


settings = Settings()  # type: ignore[call-arg]

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

MAX_TOTAL_CHARS = 200_000
