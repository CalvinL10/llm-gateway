# llm-gateway 插件：最短使用说明

**中文** | [English](README.en.md)

[下载 v0.2.0](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.2.0)

同一安装包接入不同 DSH Web Home，使用各宿主自己的 Provider、账号、工作区和存储。
不安装另一套 DSH，不复制 OAuth/订阅目录，不自动启动任务。新入口 `./plugin` 与普通会话共存；
默认入口 `.` 仍保留专用宿主的严格调用限制，旧部署不会静默变更安全语义。

## 1. 安装

先使用已有兼容 DSH、Node、pnpm。当前范围：Windows、本机 `127.0.0.1`、DSH Web；
实测 CLI 0.1.5-rc.1 / 服务包 0.1.5-rc.2 的本机兼容运行时，**包含既有本地修改**；
版本号相同不代表未经修改的上游安装兼容。本 Release 不附带运行时，不承诺任意发行版。
需要宿主提供 agentPresets 的 discovery roots/serviceFor、sessions、sessionController、
sessionProjections、workspaceRegistry、storageDomain、原生审批/工具、Web 认证服务。
缺项按启动错误处理，不通过放宽权限解决。

从上面的 Release 下载 `llm-gateway-dsh-agent-gateway-0.2.0.tgz`（不是 GitHub 自动生成的 Source code 压缩包），
保存到下面示例的 `F:\packages`，或修改命令中的路径。无需克隆仓库。

```powershell
$env:DSH_HOME = 'F:\my-dsh-home'  # 仅当前终端；换 Home 就接入另一实例
dsh plugin --profile web add F:\packages\llm-gateway-dsh-agent-gateway-0.2.0.tgz --config.auto-install-peers=false
```

bundle 默认添加 **disabled** 的 `gateway-agent-tasks` 条目。不会选账号、授权目录或调用模型。
宿主依赖由已有 DSH 提供；若 pnpm 报缺项，先检查宿主，不自动安装另一套运行时。

## 2. 配置并启用

在该 Home 的 `profiles/web/cordis.patch.yml` 添加以下配置层。
替换目录、Provider/model 为这个宿主中已存在且由你授权的值；不要照抄不存在的模型。
宿主 patch 的 `config` 是整体替换，后续编辑应保留完整配置。

```yaml
- id: gateway-agent-tasks
  disabled: false
  config:
    workspaces:
      - id: work
        label: 我的项目
        cwd: 'F:\work\my-project'
    policy:
      toolSet: development
      delegationEnabled: false
      root: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
      allowedRoutes:
        - { provider: YOUR_PROVIDER, model: YOUR_MODEL }
      maxCalls: 8
    scheduling:
      roots:
        - { provider: YOUR_PROVIDER, model: YOUR_MODEL }
      children: []
```

选择子模型时，在 `scheduling.children` 中列出明确授权的 Provider/model；任务页可选择单模型或委派。
若不使用 scheduling，则在 policy 中设置 `delegationEnabled: true`、`allowedChildRoutes`，
并把这些子路由也加入 `allowedRoutes`。整个任务树共享调用额度，不是每个子任务单独重置。
`authorizedTaskMaxCalls` 可显式列出可选额度；`authorizedContinuationCallIncrements` 默认空，
不允许继续时自行加额度。审批沿用宿主，插件不替用户批准。

### 可选：隔离命令执行

默认仍可读写授权工作区文件，但 **命令执行不可用**，不会回退到宿主 shell。
已有 Docker、兼容 PowerShell Linux 镜像及其运行配置时，可显式增加 `config.executor: docker`。
这会选择包内 `llm-gateway-single-docker` / `llm-gateway-delegate-docker` preset；
Docker shell 只在这些 preset 的隔离服务域内生效，不替换普通 DSH 的 shell。
宿主进程可通过 `DSH_GATEWAY_DOCKER_IMAGE`、`DSH_GATEWAY_DOCKER_PROFILE`（standard/browser）
和可选 `DSH_GATEWAY_DOCKER_PATH` 指定已有执行器。不会自动安装 Docker 或拉取镜像。
面板 enabled 表示选用了支持的执行器，不证明 daemon、镜像或实际开发命令已经验收；运行失败直接报错。
自定义 `policy.agentPreset` / scheduling preset 时必须自行提供等效隔离及网关工具保护。

## 3. 启动与使用

```powershell
dsh web --host 127.0.0.1 --port 3084 --no-open
```

使用宿主输出的本地登录链接（勿分享 token），点击“目标任务”。选择工作区、根/子模型、额度，
提交目标；查看结果、原生审批、取消、继续或补充说明。普通 DSH 会话继续由宿主管理。
API 保持 `/api/gateway-agent-tasks`；未登录和非法来源访问仍拒绝。
重启后的未完成任务显示 `unknown`，不会自动重放；必须显式只读核对后再决定是否继续。
命令未运行、真实模型未调用时，不应视为真实开发任务验收。

## 4. 移除与恢复

先停止/完成活动网关任务并停止该宿主，移除自己添加的 `gateway-agent-tasks` 配置覆盖层，然后：

```powershell
dsh plugin --profile web remove @llm-gateway/dsh-agent-gateway
dsh web --host 127.0.0.1 --port 3084 --no-open
```

移除不清空 Home、任务、偏好或账号。历史网关任务在重新安装兼容插件后可读取；卸载后不打开其网关 preset 会话。
恢复时安装明确保留的上一个包/版本，恢复原配置，使用同一个 Home；不要复制凭据到新 Home。
本 Release 使用 DSH 原生命令启动，不需要历史工作台的 `gateway.ps1` 或 release 目录。
遇到端口冲突时先确认占用者，不能直接终止未知进程。

本包不含运行时、测试、实验资料、历史 Home 或凭据。验证用的脚本化模型只证明接入和控制流程，
不证明真实模型开发能力、收益或费用；真实业务调用须另行明确任务和预算。
