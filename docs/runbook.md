# 运维与验证手册

> 本机日常快捷入口见 [本机使用说明](local-use.md)，插件安装见 [插件最短说明](../integrations/dsh-agent-gateway/README.md)，系统边界见 [系统架构](architecture.md)。
> 支持范围限于 **Windows、本机 `127.0.0.1` 回环、单用户明确授权工作区与显式 Docker 执行器**；不支持跨网段暴露、多租户或任意宿主 shell 回退。

---

## 1. 干净环境安装与零模型验证

在新 clone 中只从提交锁文件安装运行依赖，不复制 `.local`、旧 `node_modules` 或凭据：

```powershell
$runtime = Join-Path $PWD 'integrations/dsh-agent-gateway/runtime'
npm ci --prefix $runtime --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'core install failed' }

# 零模型 HTTP/SSE Smoke（使用本机随机端口与临时目录）
node integrations/dsh-agent-gateway/smoke/web-smoke.mjs --runtime $runtime --http
if ($LASTEXITCODE -ne 0) { throw 'zero-model smoke failed' }
```

运行全部网关回归测试时必须使用 `--test-concurrency=1` 串行执行，避免临时目录与本地端口竞争：

```powershell
$core = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
$ops  = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests/ops -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
node --test --test-concurrency=1 @core @ops
node --test docs/documentation.test.mjs
npm pack --dry-run ./integrations/dsh-agent-gateway
```

- **诚实测试边界**：`browser-ui.test.mjs` 依赖本机 Microsoft Edge；`docker-executor.test.mjs` 验证容器参数构造，实际容器命令依赖 Docker Linux Engine 与预构镜像。缺失的环境变量或环境跳过如实报告，不伪造通过。
- **真人审批交互夹具**（零模型，不执行文件修改）：`node integrations/dsh-agent-gateway/smoke/approval-manual.mjs --runtime $runtime`。

---

## 2. 受管服务生命周期与崩溃恢复

使用 `integrations/dsh-agent-gateway/ops/lifecycle.mjs` 管理专用 Home（Home、Workspace、Release 与 Runtime 必须互不嵌套）：

```powershell
$lifecycle = 'integrations/dsh-agent-gateway/ops/lifecycle.mjs'
node $lifecycle status --home $home
node $lifecycle start --home $home
node $lifecycle stop --home $home
node $lifecycle recover --home $home
node $lifecycle upgrade --home $home --release $newRelease
```

- **恢复与未知态语义**：
  - `stop` 先写入 drain 标记阻止新任务创建，待活动任务排空后通过 Home 专属 named pipe 请求优雅退出；禁止使用 `taskkill /IM node.exe`。
  - 进程退出且端口空闲、租约核对一致时，`recover` 方可重启服务；若发现未知端口占用、PID 复用或归属冲突，状态进入 `degraded` 并拒绝自动清理。
  - 启动时任何遗留的 `queued` / `running` / `cancel-requested` 任务统一标记为 `unknown`，**绝不自动重放**，只能由用户显式发起只读 `kind: reconcile`。
  - 当取消超时或持久化落盘失败时，报告保留 `stopConfirmation: "unconfirmed"` 与原占位容量，禁止私自清理锁或放宽限额。

---

## 3. 停机维护：审计导出、备份与两阶段删除

`integrations/dsh-agent-gateway/ops/maintenance.mjs` 仅管理目标 Home 下的 `storages/gateway_agent_tasks.json` 与 `sessions/`（不含配置、凭据、Release 与日志）：

```powershell
$maintenance = 'integrations/dsh-agent-gateway/ops/maintenance.mjs'
node $maintenance inspect --home $home

# 变更类维护前必须先停止并确认状态为 stopped
node $lifecycle stop --home $home
node $maintenance export --home $home --output 'F:\backup\gateway-audit.json'
node $maintenance backup --home $home --output 'F:\backup\gateway-data'
node $maintenance restore --home $home --backup 'F:\backup\gateway-data'

# 两阶段删除：先生成并人工核对条目，再精确确认 canonical Home 执行
node $maintenance delete-plan --home $home --output 'F:\backup\delete-plan.json'
node $maintenance delete --plan 'F:\backup\delete-plan.json' --confirm-home $home
```

- `export` 为脱敏审计格式（不含 `goal`、`instruction`、`artifact`、`transcript` 与凭据）；`backup` 为完整敏感业务数据，严禁上传 Git。
- 备份/删除遇到目录重定向（junction/symlink）或未停机状态将直接拒绝；部分失败时保留原件或报告 `quarantine` / `staging` 精确路径。

---

## 4. 安全边界与数据脱敏红线

- **路径与命令隔离**：[tools.js](../integrations/dsh-agent-gateway/tools.js) 在应用层拒绝 `..`、UNC/ADS/Win32 设备名、符号链接/硬链接、`.git`/`.env`/凭据目录；全仓库根目录广搜会因触发受保护路径被拒绝，应指向具体源码子目录。未配置支持 Docker 执行器时 `pwsh` 保持禁用。
- **敏感信息不入仓**：禁止将 `.local/dsh-agent-subscription-home/`、`.credentials*`、Cookie、带 token 的启动 URL 或原始任务正文写入日志、测试快照或 Git 提交。
- **独立 Python 实验**：位于 [legacy/python-cache-experiment/](../legacy/python-cache-experiment/README.md)，需切入其目录单独执行 `pytest` 与 `ruff`，与主线 DSH 运行时完全隔离。
