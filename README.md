# LLM Gateway

High-performance async LLM gateway with deterministic exact-match caching (semantic caching planned), engineered for high concurrency, determinism, and strict correctness under load.

> **Status: Round 2 of 8 — Redis L1 Exact Cache & Single-Flight Stampede Protection.**  
> This round establishes the Redis-backed L1 exact cache, per-model TTL overrides, distributed single-flight stampede protection, fail-open resilience, and temperature caching policy.

---

## Scope & Design Philosophy

### Scope — In (Round 2)
- **Redis-backed L1 Exact Cache**: Keyed off deterministic SHA-256 canonical request digests.
- **Cache Key Namespacing**:
  - Exact cache entry key: `gw:l1:{tenant_id}:{cache_key}`
  - Single-flight distributed lock key: `gw:lock:{tenant_id}:{cache_key}`
- **Cache Value Schema Versioning**: Stored as UTF-8 JSON bytes with mandatory schema version (`v: 1`). Corrupted entries or unknown schema versions fail safe to cache misses.
- **Per-Model TTL Overrides**: Default 24-hour TTL (`CACHE_TTL_SECONDS = 86400`), overridden per model via `CACHE_TTL_OVERRIDE_JSON`. Expiration is delegated entirely to Redis `EX`/`SETEX`.
- **Single-Flight Stampede Protection**: On a cache miss, exactly one request acquires a distributed lock to call upstream while concurrent duplicate requests poll and consume the cached response.
- **Fail-Open Resilience**: Cache or Redis errors never return 500s or fail requests; requests transparently fall back to direct upstream invocation.
- **Temperature Caching Policy**: Requests with `temperature > 0` bypass the cache unless explicitly opted into via `cache_policy: "allow_nondeterministic"`.
- **Response Headers**: Telemetry headers (`x-cache-tier`, `x-request-id`, `x-trace-id`, `x-upstream-latency-ms`, `x-total-latency-ms`) reporting cache outcomes without changing response body shape.
- **Application-Managed Shared Redis Client**: Single pooled Redis client initialized in FastAPI lifespan and closed on shutdown.

### Scope — Out (Deferred to Rounds 3–8)
The following capabilities are deliberately excluded from this round:
- **L2 Semantic Cache & Embeddings**: Vector indexing, cosine similarity, ONNX Runtime, and similarity search (Round 3).
- **Rate Limiting & Quotas**: Token bucket / sliding window algorithms and Redis Lua scripts (Round 4).
- **Circuit Breaker Execution**: Retry policies, exponential backoff, and fallback chain execution (Round 5).
- **Streaming / Server-Sent Events (SSE)**: Chunked transport.
- **Real Provider Adapters**: Direct external calls to OpenAI, Anthropic, or Gemini.
- **Custom Prometheus Metrics**: Metric definitions beyond the empty collector registry.
- **k6 / Load Testing**: Performance benchmarking suites.

---

## Canonical Cache-Key Derivation Rules

Cache-key derivation is load-bearing across the gateway. Keys are generated via `SHA-256(canonical_json(req))`.

| Field | Rule | Justification |
| :--- | :--- | :--- |
| `ns` | **Included** | Multi-tenant hard boundary isolation. |
| `model` | **Included** | Resolved model ID (aliases are resolved prior to keying). |
| `messages` | **Included** | Order-sensitive; message content whitespace is normalized. |
| `temperature` | **Included** | Sampling parameter changes generation entropy. |
| `top_p` | **Included** | Nucleus sampling parameter changes probability distribution. |
| `max_tokens` | **Included** | Output budget changes generation bounds. |
| `stop` | **Included** | Order-insensitive; sorted alphabetically. |
| `tools` | **Included** | Order-insensitive; sorted by function name, schema keys sorted recursively. |
| `response_format` | **Included** | Schema constraints alter output representation. |
| `stream` | **Excluded** | Output format detail; identical semantic generation. |
| `request_id` | **Excluded** | Per-request tracing metadata; must not bust cache. |
| Headers / Metadata | **Excluded** | User-agent, trace contexts, timestamps must not bust cache. |

---

## Getting Started

### Prerequisites
- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (recommended) or `pip`
- GNU Make

### Installation

Using `uv`:
```bash
# Create virtual environment
uv venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install project and development dependencies
uv pip install -e ".[dev]"
```

Using standard `pip`:
```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

### Environment Configuration
Copy `.env.example` to `.env` to configure runtime defaults:
```bash
cp .env.example .env
```

---

## L1 Exact Cache Architecture & Operational Semantics

### 1. Dual Tenant Key Namespacing
Cache entries and lock keys are derived deterministically from the canonical request:
```
gw:l1:{tenant_id}:{cache_key}
gw:lock:{tenant_id}:{cache_key}
```
The tenant appears twice by deliberate design:
1. **Inside the hashed canonical payload**: guarantees two tenants submitting identical payloads never collide on the SHA-256 digest.
2. **As a literal key prefix**: enables infrastructure operators to inspect, audit, and evict keys per-tenant using Redis `SCAN`/`KEYS` patterns (`gw:l1:{tenant_id}:*`).

### 2. Cache Value Schema & Versioning
Cached entries are stored as UTF-8 JSON bytes with a mandatory schema version:
```json
{
  "v": 1,
  "created_at": 1700000000,
  "provider": "mock",
  "model": "mock-1",
  "usage": {
    "prompt_tokens": 4,
    "completion_tokens": 12,
    "total_tokens": 16
  },
  "body": { ... }
}
```
Ephemeral per-request metadata (`upstream_latency_ms`, `total_latency_ms`, `retry_count`, `trace_id`, `cache_tier`) are excluded from storage. If an entry has `v != 1` or corrupt JSON, it is safely treated as a cache miss and overwritten on the subsequent write.

### 3. TTL Policy & Model Overrides
Expiration is delegated strictly to Redis `EX`/`SETEX`:
- **Default TTL**: `CACHE_TTL_SECONDS = 86400` (24 hours).
- **Per-Model Overrides**: Configured via `CACHE_TTL_OVERRIDE_JSON` (e.g. `{"gpt-4": 3600}`).
No client-side timestamp comparison is used for cache expiry.

### 4. Single-Flight Protocol & Stampede Protection
On a cache miss, concurrent duplicate requests are coordinated to prevent cache stampedes:
1. **Lock Acquisition**: Winner executes `SET gw:lock:{ns}:{key} {token} NX PX {LOCK_TTL_MS}` without Lua scripts.
2. **Winner Execution**: Exactly one request calls the upstream provider, writes the cache entry with the model TTL, and releases the lock in a `finally` block.
3. **Waiter Polling**: Losers enter a polling loop querying the cache at `SINGLEFLIGHT_POLL_INTERVAL_MS` (default 25ms) until an entry appears or `SINGLEFLIGHT_WAIT_TIMEOUT_MS` (default 4500ms) elapses.
4. **Startup Invariant**: `SINGLEFLIGHT_WAIT_TIMEOUT_MS < SINGLEFLIGHT_LOCK_TTL_MS` is validated at startup to ensure waiters never outlive locks.
5. **Accepted Limitation**: If an upstream call exceeds `LOCK_TTL_MS`, the lock expires mid-fetch and a second request may call upstream. Atomic `SETEX` prevents corruption; `LOCK_TTL_MS` must be set above upstream p99 latency.

### 5. Temperature Caching Policy
- If `temperature > 0` and `cache_policy != "allow_nondeterministic"`: bypasses the cache entirely (no read, no write).
- If `temperature == 0` or `cache_policy == "allow_nondeterministic"`: standard cached path.
Because default temperature is `1.0`, requests omitting `temperature` are **never** served from cache. Clients must specify `"temperature": 0` or pass `"cache_policy": "allow_nondeterministic"`.

### 6. Fail-Open Guarantees
The cache layer will **never** cause a request to fail or return HTTP 500. If Redis is unreachable, errors on connection, or times out, the gateway logs the error and calls upstream directly (`cache_tier: "miss"`).

### 7. Latency Telemetry & Segmentation
Responses include explicit telemetry headers:
- `x-cache-tier`: `"l1"` on hit, `"miss"` on miss.
- `x-request-id`: echoed from request header or generated UUID.
- `x-trace-id`: gateway trace identifier.
- `x-upstream-latency-ms`: strictly `"0.000"` on cache hits.
- `x-total-latency-ms`: wall-clock request duration.
> **Note on Latency Metrics**: Latency percentiles are only statistically meaningful when segmented by `x-cache-tier`, because cache hits (served from cache) and cache misses (incurring upstream network round-trips) represent fundamentally different latency populations.

---

## Environment Configuration
Available configuration options:
- `VERSION`: Application version string (default: `"0.1.0"`).
- `REDIS_URL`: Redis connection URL (default: `"redis://localhost:6379/0"`).
- `MOCK_LATENCY_MS`: Artificial upstream latency for mock provider (default: `0`).
- `CACHE_TTL_SECONDS`: Base cache TTL in seconds (default: `86400`).
- `CACHE_TTL_OVERRIDE_JSON`: JSON map of per-model TTL overrides (default: `"{}"`).
- `SINGLEFLIGHT_LOCK_TTL_MS`: Lock expiration in ms (default: `5000`).
- `SINGLEFLIGHT_WAIT_TIMEOUT_MS`: Waiter timeout in ms (default: `4500`).
- `SINGLEFLIGHT_POLL_INTERVAL_MS`: Polling interval in ms (default: `25`).
- `REDIS_MAX_CONNECTIONS`: Redis connection pool size (default: `20`).

---

## Development Workflow

A `Makefile` is provided with standard lifecycle targets:

```bash
# Start local development server (uvicorn on port 8000)
make dev

# Execute unit test suite (zero network / no Redis required)
# `make test` deliberately ignores any ambient REDIS_URL and always targets a dead port, so the unit suite is deterministic whether or not the developer has Redis running.
make test

# Execute integration test suite (requires Redis running on localhost:6379)
make test-integration

# Run code style and lint checks (ruff)
make lint

# Tear down background services and containers
make down
```

> **Integration Testing**: Running `make test-integration` requires an accessible Redis instance on `127.0.0.1:6379`. Spin up Redis with `docker compose up -d redis` beforehand.

---

## API Verification

Verify the running service:

```bash
# 1. Health Probe
curl -sf http://localhost:8000/healthz

# 2. Prometheus Metrics Probe
curl -sf http://localhost:8000/metrics -o /dev/null

# 3. Chat Completions (Uncached / Default Temperature)
curl -sf -X POST http://localhost:8000/v1/chat/completions \
     -H 'content-type: application/json' \
     -d '{"model":"mock-1","messages":[{"role":"user","content":"hi"}]}'

# 4. Chat Completions with L1 Exact Cache (temperature 0)
# First call: x-cache-tier: miss
# Second call: x-cache-tier: l1
curl -s -D - -o /dev/null -X POST http://localhost:8000/v1/chat/completions \
     -H 'content-type: application/json' \
     -d '{"model":"mock-1","messages":[{"role":"user","content":"hi"}],"temperature":0}'
```

---

## Docker Support

Validate container definitions:
```bash
docker compose config -q
```

Build and run gateway alongside Redis:
```bash
docker compose build app
docker compose up -d
```

