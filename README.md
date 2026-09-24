# llm-gateway

**中文** | [English](README.en.md)

面向兼容 DSH Web 的任务插件。复用宿主模型、账号、工作区、工具与审批，提供任务页面、根/子模型选择、委派、共享调用额度、取消和显式继续；不限制普通宿主会话。

## 安装

- **[安装与使用教程](integrations/dsh-agent-gateway/README.md)**
- **[下载 v0.2.0 插件包](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.2.0)**
- [v0.2.0 发布说明](docs/releases/v0.2.0.md)

下载 Release 中的 `llm-gateway-dsh-agent-gateway-0.2.0.tgz`，通过 DSH 原生 `plugin --profile web add/remove` 安装和移除。首次安装默认未启用，配置授权工作区和策略后再启用；不会自动选择账号或启动任务。

无需克隆仓库、复制整个工作台或历史 Home，也不依赖历史启动脚本。

## 源码与安装包

插件运行源码位于 [integrations/dsh-agent-gateway](integrations/dsh-agent-gateway)。`v0.2.0` 标签保存该版本的发布源码，`main` 包含后续文档更新。

GitHub 自动生成的 Source code 压缩包是源码，不是可直接安装的插件包；安装请使用 Release 附件中的 `.tgz`。本次文档语言切换不改变插件运行代码，也不替换已经发布的安装包。

## 支持范围

- 当前验收范围为 Windows、本机回环地址和兼容 DSH Web。实测 CLI **0.1.5-rc.1** / 服务包 **0.1.5-rc.2** **含既有本地修改**；相同版本号不保证未经修改的上游安装兼容。
- 命令执行需要显式配置受支持的隔离执行器；没有不受隔离的宿主 shell 回退。
- 中断任务重启后为 `unknown`，不会自动重放。
- 两个独立 Home 的接入、移除和任务控制已用本地可控响应检查；没有调用真实模型或执行真实 Docker 开发命令，不代表完整业务验收或费用收益。

[第三方归属](THIRD_PARTY_NOTICES.md)。仓库中的旧实验材料仅供历史参考，不是当前安装入口。
