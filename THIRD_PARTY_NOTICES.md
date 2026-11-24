# 第三方归属与许可证说明

P02-A 的零模型 runtime 由 `integrations/dsh-agent-gateway/runtime/package.json` 和普通 npm
`package-lock.json` 安装。`runtime/THIRD_PARTY_LICENSES.csv` 按干净安装逐项列出 520 个实际
包目录的名称、版本、package.json 许可标识及 lockfile 解析来源；它比下表更完整，但仍不能
替代各包自带的 LICENSE/NOTICE 条款。仓库不提交 `node_modules`、`.local` 或 OAuth 凭据。

| 组件 | 本项目使用方式 | 包内许可标识 / 归属 |
| --- | --- | --- |
| @deepseek-ai/dsh 0.1.5-rc.1 及 DSH 模块 | Web UI、认证路由、会话、循环、日志、存储和插件宿主 | MIT；repository: deepseek-ai/deepseek-harness |
| @deepseek-ai/dsh-tool-subagent / dsh-subagent / dsh-llm-pi-ai 0.1.5-rc.2 | 原生模型目录与选择、spawn/fork、并行/结果回传/子任务清理、可配置 API 适配器；本轮只使用脚本化回环 fixture | MIT（包内元数据）；DSH 上游能力，非本项目自研 |
| @deepseek-ai/cordis 4.0.2 / cordis-plugin-group 1.0.2 | 插件框架及 DSH app boot 必需 group peer | MIT（包内元数据） |
| @earendil-works/pi-ai 0.85.1 | 经 dsh-llm-pi-ai 间接使用的协议/流适配层 | MIT（包内元数据）；repository: earendil-works/pi |
| zod 4.6.5 | 普通运行时输入/存储字段校验 | MIT（包内元数据）；repository: colinhacks/zod |
| @eddyskywalker/dsh-chatgpt-subscription 0.3.5 | 本机已有的真实订阅连接与 OAuth；不在 P02-A core lockfile | MIT；Copyright (c) 2026 DSH ChatGPT Subscription contributors |

订阅插件的实际源码 checkout 来源为
`https://github.com/Aa728848/dsh-chatgpt-subscription.git`，版本 0.3.4，commit
`b9f5daa40bd97a74d07a640da6e0205a287d3386`；本机 profile 已安装 npm 包是 0.3.5。
两者不是同一构件，不能用源码 checkout 的 commit 伪装 0.3.5 发布包来源。0.3.5 与当前
DSH rc.2 的 peer 声明也不一致，因此没有通过 `--legacy-peer-deps` 塞进零模型 core runtime。

任务05的隔离部署脚本与历史产物说明已归档在只读 Git Tag `archive/p01-p12-history`（参见 `docs/history-snapshot.md`）；历史 `subscription-copy.mjs` 仅曾用于复制用户显式指定的已安装订阅包并保留其 LICENSE，不代表当前插件发版树内容。
ChatGPT、Google Antigravity 是外部服务来源；插件许可不代表外部服务、品牌或模型开放源代码，
也不表示本项目得到这些服务的背书。

本项目新增部分：`integrations/dsh-agent-gateway` 的目标入口、实际父子调用归属、
全树共享流调用准入/持久化失败语义、隔离配置与跨路由集成测试。测试经过真实 DSH 和
pi-ai + 本机 HTTP，但模型响应仍是脚本化替身，不是三个真实厂商接入或智能规划质量证明。
早期 `dsh-text-only` 与 `dsh-workflow` 原型已归档至 `archive/p01-p12-history`，不再保留于当前主干。

上游 UI、OAuth、Agent/tool loop、目录、并行、子任务生命周期、适配器、日志与存储
不能在展示中列为本项目自研。没有重造引擎不等于已经证明产品有独立使用价值；
项目效果仍需真实自用证据，不把调用数限制描述为准确美元预算或最优路由算法。
使用 DSH 宿主不等于调用 DeepSeek 模型；本轮真实模型新增调用 0。

若以后分发包含第三方包的成品，应保留相应包原始 LICENSE/NOTICE，并按实际分发内容重新
核对完整依赖许可。当前仓库未提供项目自身 LICENSE，本轮不擅自替作者选择开源许可证，
也不将可展示等同于已许可他人再分发。独立归档的 Python 缓存实验使用 `legacy/python-cache-experiment/pyproject.toml`
及 `uv.lock` 中的依赖，未随本轮重新打包或完成许可证清查。
