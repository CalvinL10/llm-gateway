# 历史实验与实证归档快照（P01–P12）

> **完整原始档案定位**：2026-09 期间的 P01–P12 阶段报告、`docs/evidence/`（869 份原始日志与 JSON）、旧原型目录（`dsh-task02`、`dsh-text-only`、`dsh-workflow`、`windows-docker`）、一次性 A/B 对比脚手架（`comparison-*`、`holdout-*`、`selection-*`）及旧订阅部署脚本已统一冻结保存在本地只读 Git Tag **`archive/p01-p12-history`**（指向 `120bdeb`）。随时可通过 `git show archive/p01-p12-history:<path>` 核验原始记录。

---

## 一、 核心工程里程碑（已在当前主线代码保留）

1. **P01–P05（受控任务底座与恢复语义）**：
   - 建立 `TaskLedger` 持久化状态机与 `Persist-before-Admit` 准入协议；按宿主 `parentSession` 血缘树执行全树共享 `maxCalls` 熔断。
   - 重启时将 `queued` / `running` / `cancel-requested` 统一收敛为 `unknown`，严禁自动重放，仅允许显式只读 `kind: reconcile`。
2. **P03-B & P06（权限收窄与隔离执行）**：
   - Win32 应用层路径与链接安全检查（拒绝 `..`、UNC/ADS/设备名、符号链接/junction/硬链接、`.git`/`.env`/凭据目录）；`subagent` 强制 `read-only` + `approval: never`；未显式配置 Docker 时禁用命令执行，绝不回退宿主 shell。
   - 新增显式可选 `GatewayDockerPwshExecutor`（`--network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true`）。
3. **P11–P12 & `v0.2.0`（运维生命周期与可移植原生 DSH 插件）**：
   - 收敛 `ops/lifecycle.mjs`（PID 创建时间/命令行与监听端口归属校验、drain/upgrade 失败回滚）与 `ops/maintenance.mjs`（停止态备份/恢复与两阶段安全删除）。
   - 打包为 `@llm-gateway/dsh-agent-gateway` 原生 DSH 插件，实现默认关闭、按配置启用、与普通宿主会话共存。

---

## 二、 已验证实证观察与诚实边界（不夸大 ROI）

| 实验阶段（日期） | 观测样本与实证数据 | 诚实结论与局限 |
| :--- | :--- | :--- |
| **P08-B 有限对比与多来源演示**<br>*(2026-09-20 / 21)* | 4 个开发任务 × A/B（8 单元）：累计 **53 次** HTTP 200、**176,917 inclusive tokens**（`child=0`）；独立日常实例验证 GPT → Gemini → GPT 跨来源委派（4+3 准入）及同题对照（5 准入）。 | 跑通多来源委派、鉴权、取消与不可靠重放；**样本量小且未满足等权限对照，未证实稳定提质或降本**。 |
| **P09-B 留出批实证**<br>*(2026-09-21)* | 4 题 × 8 单元：累计 **62 次**准入、**222,248 inclusive tokens**；自主完整交付改前 `3/4` vs 改后 `2/4`。其中 47/62 次观察到 `cacheReadTokens`，合计 **138,112 tokens**，约占全部输入 token 的 **66.0%**。 | 证明上游 Provider 缓存已在真实起效（不支持另造重复缓存），但受容器故障与小样本影响，**收益未证实**。 |
| **P10-A 轨迹浪费定位**<br>*(2026-09-21)* | 审计 P08 8 次可避免搜索失败（4 次全根递归触发安全拒绝 + 4 次把 workspace selector 当目录）及 P09 117 次工具调用（40,109 字符结果）：单次非 Git 沙箱误跑 `git diff` 输出 **8,467 字符**（占全部工具结果文本 **21%**）。 | 定位最大可避免浪费来自“未优先直读精确路径与盲目发现”；该行为护栏已同步合入 `index.js` 与 `tests/development.test.mjs`。 |
| **P11-B 跨日有界自用**<br>*(2026-09-22 / 23)* | 6 个原任务组 + 2 次续行，35 次生成 HTTP、**280,339 inclusive tokens**；首试技术验收 `1/6`，含人工补验后最终产物 `3/6`（原生完成且验收 `2/6`）。 | 证明本地账目可追溯（含失败与 `limited`），**尚未达到无人监督稳定提质/降本或独立生产成熟标准**。 |

---

## 三、 独立收拢的历史组件
- **`legacy/python-cache-experiment/`**：FastAPI + Redis `SET NX PX` Singleflight L1 精确缓存原型（Round 2/8，仅含 `MockProvider`，与 DSH 控制面无连接）。已在保留完整单测（`pytest` + `ruff`）的前提下移出根目录，避免混淆主线结构。
