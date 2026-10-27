# llm-gateway

**中文** | [English](README.en.md)

为 DSH 提供订阅账号连接和独立的主／子模型设置。新版面向 **DSH 0.2.1-rc.3**，直接使用普通新对话，保留宿主的 DeepSeek 和自定义 API 渠道。

## 安装

- **[新版安装与使用教程](integrations/dsh-subscriptions/README.md)**
- **[下载 v0.3.0-rc.1 候选版](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.3.0-rc.1)**
- [候选版发布说明与验证范围](docs/releases/v0.3.0-rc.1.md)

把 Release 中 `llm-gateway-dsh-subscriptions-0.3.0-rc.1.tgz` 附件的下载链接粘贴到 DSH「插件 → 添加插件」最上方输入框。按提示重启后，在「设置 → 订阅连接与模型设置」连接 Codex / ChatGPT、Antigravity 或 Claude 账号，选择主模型和子模型，再新建普通对话。安装不会自动登录或修改模型默认值。

无需克隆仓库、复制整个工作台或历史 Home，也不依赖历史启动脚本。

## 源码与安装包

新版源码位于 [integrations/dsh-subscriptions](integrations/dsh-subscriptions)。支持默认子模型及单次子代理另选模型，也可混用订阅、DeepSeek 与其他 API 渠道。独立子模型使用宿主原生 spawn 子代理；分叉和外部产品子代理沿用各自宿主设置。

GitHub 自动生成的 Source code 压缩包是源码，不是可直接安装的插件包；安装请使用 Release 附件中的 `.tgz`。

## 支持范围

- 候选版已在 Windows 上用原生 **0.2.1-rc.3** 独立测试环境验证安装、普通对话、主／子模型、跨渠道、重启和卸载，并用无界面浏览器检查原生设置页面。本机桌面后端也已在独立测试 profile 中成功加载插件。
- **桌面版粘贴链接安装、桌面通信及三家真实账号登录／模型调用仍待实际验证。** 当前测试使用受控本地响应，不证明真实订阅可用、额度扣减方式或长期兼容性。
- 三条账号连接来自社区适配器，沿用原始授权和凭据保护；不是模型平台对本插件的官方认可。

## 旧任务插件

[v0.2.0](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.2.0) 的任务页面、额度管理、取消和继续功能保留在 [旧版教程](integrations/dsh-agent-gateway/README.md)。它针对包含既有修改的 DSH 0.1.5 环境，**未在本候选版中迁移到 0.2.1**。使用新版普通对话无需安装旧任务插件。

[第三方归属](THIRD_PARTY_NOTICES.md)。仓库中的旧实验材料仅供历史参考，不是当前安装入口。
