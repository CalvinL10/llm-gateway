# AGENTS.md — llm-gateway

## 仓库定位与目录地图
- **主线核心**：[integrations/dsh-agent-gateway/](integrations/dsh-agent-gateway/README.md) 是面向兼容 DSH Web 的 Agent 任务控制面插件。发版仅含根目录 8 个核心 JS/MJS 模块、`package.json`、`cordis.patch.yml`、`README.md`、`README.en.md` 与 `presets/`（5 个预设，共 22 个文件）。
- **子目录分工**：`ops/`（本机生命周期、维护与核算）、`smoke/`（零模型 HTTP/SSE 与手动审批演练）、`tests/`（核心安全/状态机回归）、`tests/ops/`（运维与 CLI 回归）、`runtime/`（DSH 依赖锁清单）。
- **独立历史实验**：[legacy/python-cache-experiment/](legacy/python-cache-experiment/README.md) 是与主线解耦的 Python FastAPI + Redis Singleflight L1 缓存原型，仅在需要验证该实验时进入其目录独立运行。
- **架构与路线**：架构细节见 [docs/architecture.md](docs/architecture.md)，Option A 演进路线见 [PLAN.md](PLAN.md)，P01–P12 历史快照见 [docs/history-snapshot.md](docs/history-snapshot.md) 与只读 Git Tag `archive/p01-p12-history`。

## 架构不变量与安全红线
- **Persist-before-Admit**：`TaskLedger.create` / `admit` / `prepareCallAdapterBoundary` 必须先成功落盘才允许调用 `next()`；任何持久化 `await` 之后和调用适配器前必须再次检查 `stopIntents` 与 `options.signal`。
- **树级配额不可绕过**：按宿主 `origin: subagent` / `parentSession` 逐级归根计入同一共享 `maxCalls` 熔断器（`TASK_CALL_LIMIT`），失败与取消的准入绝不退款。
- **故障收敛与禁自动重放**：重启将 `queued` / `running` / `cancel-requested` 收敛为 `unknown`，只能走只读 `kind: reconcile`（禁止编辑文件、执行命令、沿用旧审批或重放副作用）。
- **边界 Fail-Closed**：保持 `127.0.0.1` 回环、Origin/Host 校验、Win32 路径/硬链接/敏感文件拒绝；未显式配置支持 Docker 隔离执行器时命令执行禁用，严禁回退宿主 shell。
- **账目诚实原则**：缺失的 token `usage` 保持 `missing` / `unknown`，严禁补 `0`；不得把调用次数限制或本地停止伪称美元预算或远端停止。
- **敏感数据保护**：禁止读取、修改或提交 `.local/dsh-agent-subscription-home/`、`.credentials*`、OAuth 凭据、Cookie 或带认证 token 的完整启动 URL。

## 历史踩坑约束（防复发）
- 修改面向发版的开发人设时必须改 `presets/` 而非已迁入 `tests/fixtures/legacy-preset/` 的旧目录；同步调整 `index.js` workspace prompt 时务必检查 `tests/development.test.mjs` 断言。
- 未经明确指令，严禁执行 `git push`、`git reset --hard`、`git clean -fdx` 或修改 `origin/main`；严禁通过放宽现有断言来凑测试全绿。

## 交付规范与验证命令
- 每轮实际改动后必须编写或更新对应测试，运行下列适用验证并保留干净的工作区，然后创建一条清晰的 Git Commit（详见 `.agents/skills/gateway-verify/SKILL.md`）：
```powershell
# 1. Node 核心 + 运维回归（必须串行防端口/目录竞争）
$core = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
$ops  = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests/ops -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
node --test --test-concurrency=1 @core @ops
# 2. 零模型 HTTP/SSE Smoke & 文档链接/发版清单合同
node integrations/dsh-agent-gateway/smoke/web-smoke.mjs --http
node --test docs/documentation.test.mjs
npm pack --dry-run ./integrations/dsh-agent-gateway
git diff --check
# 3. 独立 Python 实验（仅当改动 legacy/python-cache-experiment/ 时必跑）
Push-Location legacy/python-cache-experiment; $env:REDIS_URL='redis://127.0.0.1:6399/0'; ..\..\.venv\Scripts\pytest.exe -v; ..\..\.venv\Scripts\ruff.exe check .; Pop-Location
```
