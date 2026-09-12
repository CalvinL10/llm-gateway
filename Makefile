export REDIS_URL := redis://127.0.0.1:6399/0

.PHONY: dev test test-integration lint down

dev:
	uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

test:
	uv run pytest -v

test-integration: export REDIS_URL = redis://127.0.0.1:6379/0
test-integration:
	uv run pytest -v -m redis

lint:
	uv run ruff check .

down:
	docker compose down
