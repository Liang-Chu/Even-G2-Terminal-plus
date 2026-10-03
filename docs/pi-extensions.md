# Pi 可选 subagent 扩展

安装脚本默认联网获取与本机 Pi 版本匹配的官方 subagent 示例，也支持从本机 npm 安装目录复制。脚本可单独分发，不依赖 Even-Pilot 项目目录。它不向正在运行的 Pi 发送消息或重载它。

安装脚本是本项目编写的；扩展代码、角色正文和工作流模板来自 Pi 官方仓库。唯一的角色调整是移除 `model:` 固定值，继承当前模型。没有添加自拟的主动分工规则。

**已有官方 subagent 示例可以直接复用，无需重装。**Even-Pilot 自动安装的是 `even-pilot-monitor.ts` 监控扩展；首次安装前已打开的 Pi 仍需等空闲后 `/reload` 才会加载它。subagent 是另一个可选扩展，只有尚未启用多 agent 时才需要执行本页安装步骤。以上同时适用于 Windows 和 Linux；任意第三方 subagent 扩展不保证有同样的计数格式。

## 先理解：安装、加载、调用是三件事

Pi 可以让模型自行调用已启用的工具。`read`、`bash`、`edit`、`write` 是默认基础工具，不需要每条消息都点名使用。`subagent` 属于可选扩展，第一次需要把它加入 Pi 的扩展目录；Pi 启动或重载后注册这个工具，模型才会知道有这项能力。工具被允许使用，不代表每个任务都会用到它。

官方示例有三类文件：

| 文件 | 作用 | 是否为多 agent 必需 |
| --- | --- | --- |
| `extensions/subagent/index.ts`、`agents.ts` | 注册 `subagent` 工具，查找角色并启动子 Pi 进程 | 是 |
| `agents/scout.md` 等角色文件 | 规定角色的任务、工具和可选模型；每次工具调用时发现 | 至少一个角色 |
| `prompts/scout-and-plan.md` 等模板 | 展开 `/scout-and-plan` 等固定工作流指令 | 否，属于快捷方式 |

运行过程：主模型决定委派 → 调用 `subagent` → 扩展启动独立 Pi 子进程 → 子进程执行任务 → 结果返回主模型继续工作。安装文件本身不会启动子 agent。是否主动委派取决于任务、工具描述和指令，不是“装上以后所有任务自动拆成多个 agent”。

## 第一步：添加到 Pi 的配置目录

Linux：执行 `~/.local/bin/even-pilot enable-pi-subagents`，安装同一套官方示例，再按下方第二、三步加载和验证。

Windows 前提：Windows PowerShell 5.1 或更新版本、已安装稳定版 Pi 0.87.1 或更新版本，并能通过 HTTPS 访问 `api.github.com` 和 `raw.githubusercontent.com`。脚本不会安装 Pi 本体，也不会配置模型或 API key。

**Windows 安装器版**在 PowerShell 执行以下命令。使用自定义安装目录时，把第一行换成自己的安装根目录；这些命令只读取版本记录，不读取 connection key：

```powershell
$pilotRoot = Join-Path $env:LOCALAPPDATA 'Programs\Even-Pilot'
$pilotInstall = Get-Content -Raw (Join-Path $pilotRoot 'install.json') | ConvertFrom-Json
$pilotScript = Join-Path $pilotRoot ('versions\' + $pilotInstall.current + '\scripts\enable-pi-subagents.ps1')
powershell -NoProfile -ExecutionPolicy Bypass -File $pilotScript
```

**便携／源码版**在完整解压／checkout 目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-pi-subagents.ps1`。也可以把 `enable-pi-subagents.ps1` 单独发给其他用户，在脚本所在目录打开 PowerShell，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\enable-pi-subagents.ps1
```

这里的执行策略只用于这次进程，不修改系统设置。本项目中的脚本位于 `scripts/enable-pi-subagents.ps1`。

脚本检测本机版本，将官方 `v<版本>` 标签解析为具体 commit，再下载该 commit 下的九个文件；输出包含 `PiVersion`、`Revision` 和 `SourceLocation`，便于核对来源。如果版本不存在、下载失败或目标文件存在不同内容，安装前停止，不会改下一个版本或覆盖配置。

脚本会把 `index.ts`、`agents.ts` 放到 `~/.pi/agent/extensions/subagent/`，四个角色放到 `~/.pi/agent/agents/`，三个工作流模板放到 `~/.pi/agent/prompts/`。如果设置了 `PI_CODING_AGENT_DIR`，使用该目录。它不覆盖已有的不同内容；可重复执行以检查相同配置。自定义安装位置可传入 `-PiPackageRoot` 和 `-AgentDirectory`。

默认用户目录为 `%USERPROFILE%\.pi\agent`。全新安装应输出 `FilesAdded: 9`；相同文件已存在时显示 `FilesAlreadyPresent`。如果提示文件内容冲突，应先检查已有配置，不要覆盖。

如果无法访问 GitHub，但本机 npm 安装包包含官方示例，可显式改用本地来源：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\enable-pi-subagents.ps1 -Source Local
```

官方角色样例原本指定 Claude。脚本仅移除角色配置中的 `model:`，使子 agent 继承启动任务的当前模型与 thinking level，因此主会话使用 DeepSeek 时，子 agent 也使用 DeepSeek。扩展代码本身不改动。

这一步添加的是一组角色配置，不是安装四个本地模型；角色使用 Pi 已有的模型连接和凭据。只有实际执行子任务时，才会增加相应模型请求。

## 第二步：让当前 Pi 加载它

等当前 Pi 任务结束，在原终端输入 `/reload`，不是在 PowerShell 提示符中输入。新打开的 Pi 自动加载，无需每次再安装。留意重载时是否有扩展加载错误。

如果用户通过 `--tools` 或其他扩展限制了可用工具，还需确认 `subagent` 在允许的范围内。默认配置加载此示例后即可使用；`/tools` 是另外一个可选扩展的命令，不是启用 subagent 的必经步骤。

## 第三步：用明确指令验证一次

在 Pi 中发一条只读验证任务：

```text
使用 subagent 工具并行启动两个 scout：一个找项目入口，另一个找测试入口。只读检查，不修改文件；最后分别汇总。
```

应看到一次 `subagent` 工具调用以及两个 scout 的任务进度。主模型决定何时委派；普通任务不会强制启动多个 agent。

验收依据是终端中实际出现工具调用与子任务结果，不只是模型文字说“我用了两个 agent”。这条显式指令用于检查安装，不代表日常每条任务都必须这样写。

## 第四步：决定日常怎么分工

可以直接发普通任务，让模型决定是否调用工具；也可以使用下面的工作流模板来指定分工过程。

角色：`scout` 查找代码、`planner` 制定计划、`reviewer` 审查代码、`worker` 执行任务。工作流模板：`/scout-and-plan 任务`、`/implement 任务`、`/implement-and-review 任务`。默认仅发现用户目录的角色。

### 角色和规则的来源

脚本只安装与本机 Pi 版本匹配的[官方 subagent 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md)，保留其角色和工作流内容，仅移除固定模型以继承当前选择。不额外注入主动分工规则。需要自定义策略时，可参考 [Anthropic 关于何时使用 subagent 的说明](https://code.claude.com/docs/en/sub-agents#choose-between-subagents-and-main-conversation)；它是设计参考，不是本脚本安装的 Pi 配置。

运行子 agent 与监控计数是两个接口：Even-Pilot 已接入官方 subagent 示例，三个并行委派任务显示 `agents: 3`，串行链显示 `1`（统计未完成任务，包含队列中的任务）。未知扩展的数据格式仍显示 `1+` 下限，不猜测子任务数量。

## 其他实用官方示例

| 示例 | 用途 |
| --- | --- |
| `plan-mode/` | `/plan` 先做只读探索和计划，再进入执行 |
| `todo.ts` | 持久任务清单，`/todos` 查看 |
| `tools.ts` | `/tools` 开关当前可用工具 |
| `preset.ts` | `/preset` 切换模型、思考级别、工具与指令组合 |
| `handoff.ts` | `/handoff 目标` 把重点上下文交给新会话 |

这些是官方示例，不代表默认全部启用。建议先启用 subagent，用顺后按需要添加 plan-mode 和 todo；无需一次装齐。它们独立于 Even-Pilot。

来源：[官方 subagent 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md)、[官方扩展示例目录](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md)。

工具与自动加载参考：[Pi 扩展](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[默认工具设置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)、[终端使用](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)。
