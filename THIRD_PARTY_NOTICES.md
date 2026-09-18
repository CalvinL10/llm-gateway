# Third-party attribution

This project extends an existing runtime, not a self-built agent engine. Package metadata and bundled licenses were inspected locally; this is not a complete transitive dependency inventory.

| Component | Reused capability | Observed license |
| --- | --- | --- |
| `@deepseek-ai/dsh` 0.1.5-rc.1 and DSH modules | Web host, authentication, sessions, loop, tools, logs, storage, sandbox | MIT; launcher Copyright (c) 2026 DeepSeek |
| DSH subagent/pi-ai modules 0.1.5-rc.2 | Catalog, delegation, concurrency, child lifecycle, adapters | MIT |
| `@earendil-works/pi-ai` 0.85.1 | Protocol/stream adapters | MIT |
| `@deepseek-ai/cordis` 4.0.2 | Plugin framework | MIT |
| `@eddyskywalker/dsh-chatgpt-subscription` 0.3.5 | Subscription connection and OAuth | MIT; Copyright (c) 2026 DSH ChatGPT Subscription contributors |
| `zod` 4.6.5 | Runtime field validation | MIT |

Package metadata identifies upstream repositories including `deepseek-ai/deepseek-harness`, `earendil-works/pi`, and `Aa728848/dsh-chatgpt-subscription`. Runtime packages and generated subscription copies are not distributed here. `subscription-copy.mjs` describes a project-specific local adaptation, not unmodified upstream behavior.

Project contributions are the task API, actual-call attribution, shared admission ledger, outcome projection, confined executor integration, and tests. Integration tests use scripted responses through real DSH/adapter components; [recorded real-model acceptance](docs/verification.md) is scoped separately.

Service names imply neither endorsement nor rights to those services. This repository has no project-wide license grant; publicly visible source is not a general redistribution license. Third-party obligations apply to any separately assembled distribution. The separate Python experiment retains dependencies in `pyproject.toml` and `uv.lock`.
