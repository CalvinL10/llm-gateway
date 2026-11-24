# llm-gateway

**中文** | [English](README.en.md)

面向兼容 **DeepSeek Harness (`dsh`) Web** 的受控多 Agent 任务网关控制面插件：复用宿主模型、账号、工作区、原生工具和审批，提供受保护任务页面、主/子模型调度、树级共享调用与 Token 额度、只读 Prefix-Cache 观测、取消/重启只读核对、`gateway-otel-trace-v1` 因果血缘树及确定性 `gateway-policy-sensor-v1`（`L1/L2/L3`）门禁；普通 DSH 会话不受限制。当前 [v0.2.1 发布包](docs/releases/v0.2.1.md) 与 `main` 分支保持同步。

**插件安装与使用**：见 [插件最短说明](integrations/dsh-agent-gateway/README.md) · [v0.2.1 发布说明](docs/releases/v0.2.1.md)。
**系统架构与演进路线**：见 [系统架构](docs/architecture.md) · [Option A 路线](PLAN.md) · [AI-Native 工程规范](AGENTS.md)。

## 仓库结构

| 目录 | 定位 |
| :--- | :--- |
| [integrations/dsh-agent-gateway/](integrations/dsh-agent-gateway/README.md) | `@llm-gateway/dsh-agent-gateway` 插件发布核心（根目录 8 个运行模块 + `presets/`） |
| `integrations/dsh-agent-gateway/ops/` | 本机受管服务生命周期（`lifecycle.mjs`）、停机维护（`maintenance.mjs`）与离线核算（`cost-report.mjs`） |
| `integrations/dsh-agent-gateway/smoke/` | 零凭据 HTTP/SSE Smoke（`web-smoke.mjs`）与手动审批演练（`approval-manual.mjs`） |
| `integrations/dsh-agent-gateway/tests/` | 网关核心安全/状态机/可移植性回归测试及 `tests/ops/` 运维测试 |
| [docs/](docs/architecture.md) | [系统架构](docs/architecture.md)、[运维与验证手册](docs/runbook.md)、[本机日常入口](docs/local-use.md)、[历史实证快照](docs/history-snapshot.md) |
| [legacy/python-cache-experiment/](legacy/python-cache-experiment/README.md) | 独立归档的 Python FastAPI + Redis Singleflight L1 缓存实验（与 DSH 主线隔离） |

## 快速验证

```powershell
# 1. 网关核心与运维回归（串行执行）
$core = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
$ops  = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests/ops -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
node --test --test-concurrency=1 @core @ops

# 2. 零模型 HTTP/SSE Smoke、文档合同与发版包边界检查
node integrations/dsh-agent-gateway/smoke/web-smoke.mjs --http
node --test docs/documentation.test.mjs
npm pack --dry-run ./integrations/dsh-agent-gateway
```

## 支持范围与诚实边界

- 当前仅验收 **Windows、本机 `127.0.0.1` 回环、兼容 DSH Web 组合**；不声称跨系统或公网多租户生产就绪。
- 未显式配置受支持的隔离执行器（`executor: docker`）时命令执行禁用，绝不回退到不受隔离的宿主 shell。
- 进程重启后的活动任务统一收敛为 `unknown`，禁止自动重放，必须由用户显式发起只读核对。
- P01–P12 历史实证汇总见 [历史快照](docs/history-snapshot.md)（完整原始记录保存在只读 Git Tag `archive/p01-p12-history`）；缺失的 token 用量记为 `unknown/missing`，未宣称稳定降本或提质收益。
- [第三方归属](THIRD_PARTY_NOTICES.md)。
