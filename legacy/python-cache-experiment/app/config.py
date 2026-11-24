"""Configuration management using pydantic-settings."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Gateway runtime settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    VERSION: str = "0.1.0"
    REDIS_URL: str = "redis://localhost:6379/0"
    MOCK_LATENCY_MS: int = 0
    CACHE_TTL_SECONDS: int = 86400
    CACHE_TTL_OVERRIDE_JSON: str = "{}"
    SINGLEFLIGHT_LOCK_TTL_MS: int = 5000
    SINGLEFLIGHT_WAIT_TIMEOUT_MS: int = 4500
    SINGLEFLIGHT_POLL_INTERVAL_MS: int = 25
    REDIS_MAX_CONNECTIONS: int = 20

    def model_post_init(self, __context: object, /) -> None:
        super().model_post_init(__context)
        if self.SINGLEFLIGHT_WAIT_TIMEOUT_MS >= self.SINGLEFLIGHT_LOCK_TTL_MS:
            raise ValueError(
                "SINGLEFLIGHT_WAIT_TIMEOUT_MS must be strictly less than SINGLEFLIGHT_LOCK_TTL_MS"
            )


@lru_cache
def get_settings() -> Settings:
    """Return cached application settings singleton."""
    return Settings()
