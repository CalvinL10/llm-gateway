# PLAN.md — LLM-Gateway 演进路线（Option A）

## 架构定锚与路线取舍
- **选定方向（Option A）**：聚焦 [integrations/dsh-agent-gateway/](integrations/dsh-agent-gateway/README.md) 控制面，将其从“事前准入与故障隔离网关”升级为**可验证的 AI-Native Agent Harness Control Plane**；[legacy/python-cache-experiment/](legacy/python-cache-experiment/README.md) 独立收拢、保持可测，不再与主线混杂。
- **为何选 Option A 而非双栈重造（Option B）**：DSH 控制面已具备 ~2,600 行高严谨度的状态机、树级熔断、Win32/Docker 边界与可移植插件能力；在有限开发窗口内集中补齐在线 Token/成本与 Prefix-Cache 治理、事后确定性 Sensor 与血缘核验、受控离线 Reflection 闭环，能零费用、100% 确定性复现并与前沿工程（Guides/Sensors/Reflection、Router-Worker、防作弊门禁）直接对齐，避免把精力分散在双语言 HTTP Proxy 胶水上。

---

## 分片推进清单（Slices）

- [x] **Slice 0：结构清洗与 AI-Native 工程底座**
  - **动作**：于 `120bdeb` 冻结 `archive/p01-p12-history` 只读归档标签；清理 `.tmp-p11-index.patch`、残留 `runtime/delegation-test-3c1G9m/`、P01–P12 原始实验海与废弃原型；将 Python 缓存实验迁入 `legacy/python-cache-experiment/`；重组 `ops/`、`smoke/`、`tests/`、`tests/ops/` 并保持发版核心零路径破坏；落盘 `AGENTS.md`（≤80 行）、`.agents/skills/gateway-verify/`、`docs/architecture.md`、`docs/history-snapshot.md` 与轻量 `docs/documentation.test.mjs`。
  - **验收**：全部 Node 核心/运维测试通过、`web-smoke.mjs --http` 通过、`npm pack --dry-run` 仅包含 21 个发版文件、独立 Python `pytest` + `ruff` 全绿、`git diff --check` 无告警。

- [ ] **Slice 1：在线 Token/等价成本硬治理 + Prompt Prefix-Cache 观测**
  - **动作**：在 `TaskLedger` 与 `llm/stream` 拦截链引入在线累计 Token / 等价美元软告警与硬熔断（不仅限于 `maxCalls` 次数）；基于 `cacheReadTokens / (inputTokens + cacheReadTokens)` 在 `report.js` 追踪 Prefix-Cache 命中率与跨轮前缀击穿告警；探索受控模型路由降级策略。
  - **为什么先做它**：`cost-report.mjs` 目前仅事后算账，无法在任务执行中拦截 Token 爆炸与 KV-Cache 击穿。

- [x] **Slice 2-Lite：标准 Trace/Span 血缘树 + 事后确定性 Policy Sensor**
  - **动作**：升级 `report.js` 输出 `gateway-otel-trace-v1` 因果血缘树（`task -> attempt -> llm -> tool -> approval / denial / sensor`）；在 `index.js` + `ledger.js` + `report.js` 落地只读 Git Baseline/Delta 测试与契约防篡改审计（隔离父仓 `.git` 并支持预存在脏工作区去噪）、物理命令/文件证据 vs 文本声明交叉核验，输出脱敏 `gateway-policy-sensor-v1`（`L1_AUTO_PASS` / `L2_AUTO_WARNING` / `L3_HUMAN_REQUIRED` 分级门禁），保持 `businessOutcome: 'unverified'` 与 21 文件发版边界不变（可选的 Docker 自动重跑验证继续延后不越权触发）。
  - **为什么做它**：消除 `businessOutcome: 'unverified'` 下缺乏策略合规与防作弊可观测信号的盲区，实现“事前准入约束 + 事后确定性验真”。

- [ ] **Slice 3：受控离线 Reflection/Dreaming + 可选 Git Worktree 并发隔离**
  - **动作**：新增只读离线 `reflect` 管线，从脱敏 `auditExport` 聚类高频拒绝、工具报错与 `unknown` 轨迹，生成候选规则/`AGENTS.md` 补丁草案并强制卡在“人工审查 + 回归测试门禁”后才能晋升；视需要演进同仓库并发从单写租约走向独立 Git Worktree 隔离。
  - **为什么做它**：将历史 Bad Case 转化为可审计的团队级规则进化闭环，同时防大模型幻觉污染长期规范。
