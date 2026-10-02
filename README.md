# Even-Pilot

在 Windows 或 Linux 正常使用 **Pi / Codex / Claude Code**，在手机和 Even G2 上查看进度、切换已 Watch 的会话、发送文字或语音。完整输出仍在原生终端里。

Windows / Linux / Hub：**1.0.22**。名称统一为 **Even-Pilot**；手机首页按设备分组，工具记录默认折叠；眼镜隐藏离线会话。支持各电脑独立推送，或通过一台中心服务器统一转发 Glance 通知。眼镜交互仍待真机验收。

## 1. 准备电脑和 CLI

1. 使用 **Windows 10/11 x64**，或 **Linux x86_64 / glibc**。Linux 实测基准为 Ubuntu 26.04 LTS；使用发行版通用安装包，不依赖 apt/rpm。两端安装器都已包含 Node 和所有后端依赖。Linux 详细要求见[Linux 安装](docs/linux.md)。
2. 只安装你要使用的 CLI，已有的可以跳过。CLI 仍使用自己的登录和运行环境；此包不接入 WSL 内的终端。

| CLI | 安装和首次登录 |
| --- | --- |
| Pi | 安装 [Node.js 24 LTS](https://nodejs.org/en/download) 后，PowerShell 执行 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`；进入项目目录运行 `pi`，按[官方入门](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)配置模型登录或 API key。 |
| Codex | 按 [OpenAI 官方 Windows 安装步骤](https://learn.chatgpt.com/docs/codex/cli)安装 CLI；进入项目目录运行 `codex`，完成首次登录。 |
| Claude Code | PowerShell 执行 `winget install Anthropic.ClaudeCode`，重新打开终端后运行 `claude` 并登录。详见[官方入门](https://code.claude.com/docs/en/quickstart)。 |

3. 在该 CLI 里先完成一次普通对话。Even-Pilot 复用 CLI 自己的登录，不需要在本应用重复填写模型 key。

## 2. 启动桌面端

### Windows

1. 双击 **Even-Pilot-1.0.22-Setup-x64.exe**，点击 **Install**。安装本身可离线完成，无需管理员权限。
2. 完成后自动打开会话管理页，桌面和开始菜单生成 **Even-Pilot** 快捷方式。以后直接双击快捷方式。默认端口为 **4317**。
3. 新安装默认位于 `%LOCALAPPDATA%\Programs\Even-Pilot`。检测到正在运行的便携版时，默认在原目录升级，保留 `.local` 的 key、Watch 和订阅；可用 **Browse** 选择位置。
4. 如需开机启动，右键托盘，勾选 **Start with Windows**。以后登录 Windows 时安静启动；双击托盘打开管理页。

此版本 EXE 尚未签名。`.local` 保存本机 connection key 和 Watch 设置，请保留，不要分享。**Quit Even-Pilot 只退出托盘；Unwatch 和停止监控后台都不会杀死原生终端。**

后台启动失败会重试；数据目录中的 `desktop-startup.log` 记录启动阶段，不记录 connection key。手动打开 EXE 会打开管理页。

Windows 设置 → 应用 → **Even-Pilot** 可卸载。卸载前关闭连接中的原生终端，卸载器不会替你杀进程，且保留 `.local` 连接数据。升级再次运行安装 EXE 即可；旧版本文件保留到卸载，保证仍在运行的终端可继续工作。ZIP 是可选便携版，也已包含运行环境，完整解压后直接运行 EXE，不需要 `Setup.cmd`。

### Linux（桌面或 SSH / NUC）

1. 下载 **Even-Pilot-1.0.22-Setup-linux-x64.run**，在文件所在目录运行，**不要加 sudo**：

   ```sh
   sh ./Even-Pilot-1.0.22-Setup-linux-x64.run
   ```

2. 有图形桌面会打开管理页，以后从应用菜单打开 **Even-Pilot**。无桌面时安装器打印管理地址；执行 `~/.local/bin/even-pilot pair` 查看 URL、connection key 和二维码。Glance 可扫码后保存注册；Even Hub 目前手工填写 URL/key。
3. 在 Linux 上先安装并登录所需的 CLI，已有的跳过。Pi/Codex 可使用各自的 npm 包，Claude 按[官方 Linux 安装说明](https://code.claude.com/docs/en/quickstart)；Even-Pilot 不复制 Windows 的登录信息。需要后台打开终端的无桌面环境先安装 `tmux`，Claude 连接器另需 `python3`。
4. 可选登录自启动：`~/.local/bin/even-pilot autostart on`。服务器要在退出 SSH 后、重启后持续运行，按 [Linux 指南](docs/linux.md)启用用户 lingering。
5. `~/.local/bin/even-pilot status` 查看状态；`stop` 停监控，`start` 启动，`uninstall` 卸载。退出网页、停止后台和 Unwatch 都不终止 CLI。卸载前自行关闭连接中的终端；key 保留在 `~/.local/share/even-pilot`。

**更新：**安装器安装后，运行 `~/.local/bin/even-pilot update` 即可下载、校验并更新。不使用 `npm update`。也可下载新版 `.run` 后再次安装；key、Watch 和推送设置保留。

**纯 SSH 管理：**运行 `even-pilot sessions` 列出会话，用列表里的短 KEY 执行 `watch KEY`、`unwatch KEY`、`select KEY`、`send KEY "prompt"`。`new codex --cwd ~/project` 在无头环境中创建 tmux 终端；`terminal codex` 在当前 SSH 终端交互。以上命令均可使用完整路径 `~/.local/bin/even-pilot`，不要求浏览器。完整示例见 [无头 CLI 操作](docs/linux.md#3-无桌面--nuc)。

有桌面时选中会话会打开普通终端；无桌面时打开 `pilot-*` tmux 会话，`tmux ls` 查看、`tmux attach -t 会话名` 接回。断开 SSH 或 tmux detach 不是任务完成。具体命令及无 systemd 环境见 [Linux 指南](docs/linux.md)。

## 3. 让已有或新开的 CLI 接入监控

以下规则同时适用于 **Windows 和 Linux**。已有并已登录的 CLI 不需要重装或重复填模型 key；Even-Pilot 后台须与 CLI 使用同一个系统用户。仅仅在列表里看到保存的历史，不代表那个终端已经接入实时监控。

| 已经在运行的 CLI | 首次接入要做什么 | 接入后能做什么 |
| --- | --- | --- |
| Pi | Even-Pilot 启动时自动安装监控扩展。安装前已打开的 Pi，**等任务结束后在原终端输入一次 `/reload`**；以后新开的 Pi 自动加载。 | 实时监控、完成通知，以及向同一会话发送 prompt。无需额外 MCP。 |
| 普通 `codex` / Codex 桌面 App 的本地会话 | **无需额外配置或重开窗口**；后台自动读取本机记录，新会话通常在数秒内出现。 | 只读监控和完成通知；不能经此通道发送 prompt 或终止任务。 |
| 普通 `claude` | **不能自动接入实时监控**。等当前任务结束后正常退出 CLI，再从 Even-Pilot 的会话列表选中原会话打开。 | 通过连接器监控、发送 prompt 和接收完成通知；Claude 支持仍为实验状态。 |

需要新建可远程输入的 Codex/Claude 会话时，在管理页点击 **+ New terminal**，选择 Tunnel 和项目目录；连接器随原生终端启动。Claude 需在原生终端确认 **local development channel**，Hooks/MCP 按本次启动配置，不覆盖全局设置。组织账号若禁用了 Channels，按[官方说明](https://code.claude.com/docs/en/channels#enterprise-controls)开启。Linux 无头命令见[Linux 接入 CLI](docs/linux.md#2-接入-cli)。`/reload` 仅用于 Pi。

启动管理页默认 Watch 最近 24 小时更新的会话；接入后的新任务会自动进入 Watch，也可手动勾选。完成通知只针对监控到的后续完成事件，不补发启动前已结束的任务。眼镜当前显示的会话不推送到 Glance。Unwatch 和后台退出不终止原生任务。

默认读取该用户的 CLI 配置目录。使用自定义 `PI_CODING_AGENT_DIR`、`CODEX_HOME` 或 `CLAUDE_CONFIG_DIR` 时，启动 Even-Pilot 的环境也须使用相同目录。WSL、容器或其他电脑里的 CLI 不由本机后台跨环境自动接入；另一台电脑需单独运行 Even-Pilot。

### Pi 多 agent（可选）

**监控扩展和 subagent 扩展是两回事。**基础 Pi 监控不需要 subagent；Even-Pilot 不会自动给 Pi 安装多 agent 能力。若已安装并加载受支持的 **Pi 官方 subagent 示例**，直接复用，无需重装。其他第三方扩展的精确子任务计数不保证支持。

尚未启用时，只需安装一次：

1. **Windows：**右键 Even-Pilot 快捷方式 → 打开文件所在的位置，在该文件夹打开 PowerShell：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-pi-subagents.ps1
   ```

   **Linux：**

   ```sh
   ~/.local/bin/even-pilot enable-pi-subagents
   ```

2. 等 Pi 空闲，在 **Pi 终端内**输入 `/reload`；以后新开的 Pi 自动加载。
3. 发一条验证指令，例如：`使用 subagent 工具并行启动两个 scout，一个查项目入口，一个查测试入口，只读检查。` 以终端实际出现工具调用为准，不只看模型口头回复。

脚本联网获取与本机 Pi 版本匹配的官方示例，子任务复用当前模型和已有凭据，不添加自编分工规则、不覆盖不同的已有配置。安装后由模型决定是否委派，不会每条任务都自动启动多个 agent。官方示例三个并行未完成任务显示 `agents: 3`，串行链显示 `1`；统计包含排队的任务，未知扩展仍可能显示 `1+`。详见[安装与验证步骤](docs/pi-extensions.md)。

## 4. 用 Tailscale 连通手机和电脑

1. 在 [Windows](https://tailscale.com/docs/install/windows) 或 [Linux](https://tailscale.com/docs/install/linux)，以及[安卓](https://tailscale.com/docs/install/android)／[iPhone](https://tailscale.com/docs/install/ios)安装 Tailscale，用同一个账号登录，确认两台设备在线。Linux 安装后执行 `sudo tailscale up` 完成登录。
2. 找到**运行 Even-Pilot 的电脑**的 `100.x.x.x` 地址，Linux 可执行 `tailscale ip -4`。手机浏览器打开 `http://电脑的Tailscale地址:4317`，应能看到 Even-Pilot 页面。
3. 电脑保持开机、不休眠，手机保持 Tailscale 连接。这里只连接两台设备，不需要子网路由或出口节点。

地址属于每个用户自己的电脑，包里不写死。`0.0.0.0` 是监听地址，不能填到手机。数字 IP 不依赖 MagicDNS。打不开时检查两端 Tailscale 和主机防火墙是否允许 TCP 4317；程序不会自动改防火墙，也不需要路由器公网端口转发。

## 5. 在 Even Hub 连接桌面

1. 在 Even Hub 上传／安装 **even-pilot-1.0.22.ehpk**，使用 Even App **2.2.10 或更新版本**，确认 G2 已连接手机。
2. 桌面点击 **Phone URL & key**，复制 **Bridge URL** 和 **Connection key**。URL 应使用上一步手机能打开的电脑地址。
3. 手机的 Even Hub 中打开 **Even-Pilot → Connection**，粘贴两项，点击 **Save computer**。Key 只填原值，不加 `Bearer`。
4. 在手机 **Sessions** 首页确认设备显示 **Online**，再从眼镜打开 Even-Pilot。默认进入上次打开的已 Watch 会话；没有时先在手机或桌面勾选 Watch。

成功后 URL/key 自动保存，下次直接打开即可。临时断网会重连，不会取消 Watch。当前 Hub 使用手工连接；桌面二维码保留给支持扫码的客户端。

若长标签被设备拒绝，会先缩短标签并保留原状态栏，手机显示 **G2 connected · compact labels**；这种情况下中文可能无法铺满整行。若页面仍被拒绝，再切换为全原生的 **basic view**。若显示异常，请保留手机状态栏整行错误。手机 G2 预览下方可展开 **G2 input diagnostics** 查看收到的手势；只保留本次打开的最近 60 条事件元数据，不包含消息、录音或 key。不需要清除 URL/key 或重启电脑上的工作会话。

### 同时连接多台电脑（例如笔记本 + NUC）

1. 每台电脑都安装并启动 Even-Pilot，分别取得该电脑的 Tailscale URL 和 connection key。不要把一台电脑的 key 填到另一台的地址里。
2. 在桌面管理页或手机 Even Hub 中打开 **Connection / Bridge settings → + Add computer**，填入另一台电脑的两项信息，点击 **Save computer**。可保存最多 16 台，之后自动同时重连。
3. 手机默认打开 **Sessions**：按设备分组，组内按最近更新时间排序。用 **All devices** 选择设备，**All / Watched / Running** 筛选会话，搜索标题、项目或模型。每组先显示最近 8 条，点 **Show more** 加载其余会话。新建会话时先选 **Computer**，再填写那台机器上的项目路径。
4. 眼镜的 Sessions 只列**已 Watch 且当前在线**的会话；离线设备或断开的终端暂时隐藏，恢复后重新显示，不取消 Watch，菜单和顶部状态栏显示来源，例如 `nuc · agents: 3 | Codex · model | 会话标题`。切换后 prompt、取消任务和通知抑制都只作用于该会话所在的电脑。

来源名自动读取 Tailscale 设备名；获取不到时显示系统主机名，Connection 中明确提示。断线的电脑显示 Offline，保留会话和 Watch；其余电脑可继续使用。删除连接只从当前设备忘记 URL/key，不关闭服务器或终端。

电脑列表保存在**当前浏览器／Even App**，请在要使用的管理页和手机端分别添加两台电脑；服务器之间不交换 connection key。两端后端和 Hub 均使用本次更新的包。Glance 独立推送时每台电脑配置 watcher；集中转发时只配置中心电脑的 watcher。

## 6. 日常操作

- **手机页面：**顶部 **Sessions / Conversation / G2** 切换。点会话立即进入 Conversation，可查看反馈和发送 prompt；连续工具记录默认折叠成 **Tools · N calls**，点开看详情；运行信息收在 **Session details**。G2 预览和诊断在 G2 页，连接和语音设置仍在顶部。**Watching** 表示已监控，再点一次取消监控，不停止终端。
- **会话管理：**桌面每次显式打开时默认 Watch 最近 24 小时更新的会话。勾选 Watch 不弹窗口，选中才打开；Unwatch 不影响原终端。眼镜只显示当前在线的已 Watch 会话，系统菜单 **Sessions** 切换。
- **眼镜会话页：**原生单列列表，最上面是 **+ New prompt**，单击进入编辑。下面最多保留最近十条消息，最新在前；每条只占一行，正文超长以 `...` 截断。两种箭头都在左侧：`←` 为 agent，`→` 为你。首次历史到达时自动显示，无需手动刷新。滑动选择、单击展开全文，双击回到列表；超长全文用菜单 **Next part / Previous part** 查看，更早历史在手机或电脑查看。
- **退出与终止：**列表页双击弹出退出确认，正在运行的任务继续。**Terminate task** 中断当前指令，排在应用菜单项首位、**Sessions** 前面；系统项由固件插入，不能固定整个菜单的行号。已移除菜单中的 Refresh messages 和 New prompt。列表和全文阅读期间，新消息不重置位置；出现 **+new** 时，从全文／编辑页返回列表即可载入最新消息。
- **编辑页：**单击开始／停止录音；长按删除上一段，每秒一段；空白草稿双击直接返回会话；有文字、已录音或等待转写时，双击弹出原生确认，默认选中 **Send & exit**（发送并返回会话），另一项 **Exit only**（丢弃草稿并返回会话）。单击确认；确认页双击返回编辑，保留草稿。空草稿不发送。菜单第一项 **Back** 丢弃草稿并返回，后面保留 **Send**。转写未完成时等完整结果再发送，失败不发送残缺草稿。
- **语音设置：**手机 **Voice** 中选择 OpenAI 或 ElevenLabs，填写自己的 API key 并保存。默认保存在手机，**Clear all keys** 可清除。语音 key 与 connection key 不同，详见[语音说明](docs/voice.md)。
- **手机输入：**支持普通 prompt、部分命令和选择题／审批，范围见[连接器说明](docs/connectors.md#phone-commands-and-choices)。

**通知方式：**在 **Connection / Bridge settings → Glance notifications → Notification routing**，选择电脑，再选 **Send directly from this computer** 或 **Forward via <中心设备>**。集中转发只需在中心配置 FCM 和 Glance PUSH watcher，手机不必保持 Hub 打开；详见[集中转发设置](docs/notification-routing.md)。

**Glance（可选）：**可扫码使用同一个桌面 connection key 接收每个会话归零通知；眼镜当前打开的会话不推送。配置按 [Glance 项目指南](https://github.com/Liang-Chu/Glance)操作。

## 更新、开发与接口

安装版再次运行对应系统的安装包即可更新，保留原 key 和 Watch；便携版和源码的手动更新见[更新与源码构建](docs/development.md)。新 Hub 包需要重新上传安装。

- [API 要求和端点](docs/api.md) · [连接器与兼容性](docs/connectors.md) · [G2 摘要格式](docs/g2-output-contract.md)
- [文档目录](docs/README.md) · [1.0.22 发布说明](RELEASE_NOTES.md) · [验证结果与已知限制](docs/release-status.md)

Claude 连接器暂列实验支持：实际模型响应和真实终端取消尚未完成验收。当前 Hub 完整布局、手势和蓝牙性能仍需实机复测，具体边界见[发布状态](docs/release-status.md)。

## 应用更新

- 默认每天检查一次 GitHub 正式发布，只提示，不自动安装。Windows 托盘和手机／桌面管理页的 **Updates** 可查看版本并点击更新；多设备时先选择 Computer。
- 关闭 **Automatically check for updates** 后不再后台请求或显示新版本提醒，设置保存在对应电脑，重启后仍有效。**Check now** 可手动检查。
- Linux：`even-pilot update` 更新，`update check` 只检查，`update off` 关闭自动检查，`update on` 恢复，`update status` 查看状态。命令也可写完整路径 `~/.local/bin/even-pilot`。
- 更新校验 GitHub 发布的 SHA-256，保留连接及监控设置，仅重启监控后台；启动检查失败会尝试恢复之前版本。已有原生终端继续运行。源代码目录不自动覆盖，先使用安装器安装即可启用应用内更新。
- 发布下载：[GitHub Releases](https://github.com/Liang-Chu/Even-Pilot/releases)。Hub 包仍在 Even Hub 中单独上传／更新。详见[更新说明](docs/updates.md)。
