# 本机使用：已安装的 llm-gateway 0.2.0

通用安装、配置、使用和移除见 [插件最短说明](../integrations/dsh-agent-gateway/README.md)。
插件不是此工作台的专用程序；同一个安装包已在两个独立 Home 中通过 DSH 原生安装/移除。历史里程碑见 [历史实证快照](history-snapshot.md)。

## 当前日常实例

- 插件：`@llm-gateway/dsh-agent-gateway@0.2.0`，安装在原 Home 的 `profiles/web/node_modules`。
- Home：`F:\project\llm-gateway\.local\dsh-agent-subscription-home`；账号、13 条原任务、工作区授权、模型目录、默认选择和额度保留。
- 生效配置：`F:\project\llm-gateway\.local\plugin-release-0.2.0\subscription.patch.json`。
  这是兼容启动辅助使用的**纯配置目录**，不含另一份插件代码；不要再编辑旧 release。
- 复用运行时：`F:\project\llm-gateway\integrations\dsh-agent-gateway\runtime`。
  本机 CLI 0.1.5-rc.1 / 服务包 0.1.5-rc.2 含既有本地修改；未验收任意上游同版本安装。
- 新任务使用包内 preset。旧任务保留原 preset 名称，其工具和隔离执行器已改为包引用，不再依赖旧 release 路径。
- 保留显式 Docker 配置；只作用于网关 preset。普通会话的 shell、标题生成、重试和模型设置由宿主管理。

## 启动和使用

```powershell
& 'F:\project\llm-gateway\gateway.ps1' start
& 'F:\project\llm-gateway\gateway.ps1' status
```

浏览器入口：`http://127.0.0.1:3084/`。未登录返回 401 是正常行为。
首次登录链接在该 Home 的 `.gateway-lifecycle/service.stdout.log` 中，只在本机打开最后一次启动的链接；
不要分享或提交 token、Cookie、凭据或完整日志。打开“新目标与任务”，选择工作区、主/子模型和共享调用上限。
现有 t1/t2/t3/local-acceptance 均保留，不能当作空目录覆盖。调用次数不是费用预算。

`gateway.ps1` 不是插件必需入口。停止辅助管理的实例后，也可直接使用已有 DSH：

```powershell
$env:DSH_HOME = 'F:\project\llm-gateway\.local\dsh-agent-subscription-home'
node --expose-internals 'F:\project\llm-gateway\integrations\dsh-agent-gateway\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js' web --patch 'F:\project\llm-gateway\.local\plugin-release-0.2.0\subscription.patch.json' --host 127.0.0.1 --port 3084 --no-open
```

直接启动的进程由该终端管理，不要和辅助入口同时启动，也不要让辅助入口接管未知 PID。
其他 Home 不需要这个配置目录，按通用说明使用自己的 `profiles/web/cordis.patch.yml` 即可。

## 停止、异常恢复和移除

```powershell
# 先取消活动任务并等待 stopped。
& 'F:\project\llm-gateway\gateway.ps1' stop
& 'F:\project\llm-gateway\gateway.ps1' start
```

旧 PID 已退出且端口空闲时，start 在既有锁/归属检查内恢复；活 PID、端口冲突和不明租约拒绝自动处理。
需要进一步核对时使用 status / recover，不手删锁，不杀未知进程。
重启不重放任务，unknown 必须先显式只读核对，再决定是否继续。
移除遵循通用说明，并且不再给宿主传入上面的网关配置 patch；原 Home 数据不删除。

## 唯一指定回退版本

回退目标：`F:\project\llm-gateway\.local\local-use-release-9ee5162`。
原有历史目录本轮没有批量删除，但不再作为日常代码依赖。
确需回退时，先停止活动任务和本轮实例，再执行：

```powershell
$env:DSH_HOME = 'F:\project\llm-gateway\.local\dsh-agent-subscription-home'
node --expose-internals 'F:\project\llm-gateway\integrations\dsh-agent-gateway\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js' plugin --profile web remove '@llm-gateway/dsh-agent-gateway'
$backup = 'F:\project\llm-gateway\.local\plugin-portability-check\daily-before-presets'
Copy-Item -LiteralPath "$backup\gateway-agent.yml" -Destination "$env:DSH_HOME\.agent-presets\gateway-agent\agent.cordis.yml"
Copy-Item -LiteralPath "$backup\gateway-agent-delegation.yml" -Destination "$env:DSH_HOME\.agent-presets\gateway-agent-delegation\agent.cordis.yml"
node 'F:\project\llm-gateway\integrations\dsh-agent-gateway\ops\lifecycle.mjs' upgrade --home $env:DSH_HOME --release 'F:\project\llm-gateway\.local\local-use-release-9ee5162'
& 'F:\project\llm-gateway\gateway.ps1' start
```

任何命令失败就停止，不继续覆盖配置。回退会恢复旧专用宿主行为，而不是普通会话共存；它不回滚任务数据。

## 这次实际确认的边界

- 同包、两个独立 Home：原生安装默认关闭，配置后页面/API 可用；普通会话可回答，网关身份/额度/工具/审批限制保留。
- 本地可控模型：结果、委派、取消、继续、共享限额、中断重启不重放；原生卸载后宿主正常，重装后记录/偏好仍在。
- 日常实例：陈旧 PID 正常恢复，迁移后页面/API、认证和来源检查通过，原任务状态及调用数未增加。
- 最终包重装后出现过一次 30 秒启动超时；启动管理器已清理该次进程，正常 start 重试后运行正常。该次超时根因尚未定位。
- **没有真实模型调用，没有运行真实 Docker 开发命令，也没有宣称完整业务任务验收。**
- 记录：`F:\project\llm-gateway\.local\plugin-portability-check\result.json` 和同目录 `daily-result.json`。
  临时产物集中在这一目录；没有修改全局环境变量，没有重跑历史比较实验。
