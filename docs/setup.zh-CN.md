# 首次安装、连接和日常操作

从一台已经能使用 Pi、Codex 或 Claude Code 的电脑开始，不需要以前的 Terminal+ 配置。先跑通见[快速开始](../README.zh-CN.md)；[English](setup.md)。

本文对应 **Terminal+ 1.1.12**。已有安装先按[一次性迁移](updates.md#migration-from-even-pilot)升级。

## 先分清四个部分

| 部分 | 安装位置 | 作用 |
| --- | --- | --- |
| Windows EXE／Linux 电脑端（npm／`.run`） | 每台需要监控的电脑 | 读取本机 CLI 状态、保存 Watch、提供 4317 端口的 API 和管理页 |
| Even Hub `.ehpk` | 手机的 Even Hub | 同时连接多台电脑，控制 G2 显示和输入 |
| 原生 Pi／Codex／Claude | 原来的电脑、原来的系统用户 | 执行任务，保存完整输出及模型登录 |
| Glance，可选 | 手机 | 接收已配置发送端的完成通知 |

Terminal+ 是监控和简单会话管理端。桌面管理页只控制提供这个页面的电脑，手机 Hub 汇总已保存电脑的会话。它不替你安装 CLI，也不需要重复填写 CLI 的模型 key。语音转写和通知发送是各自独立的可选配置。

## 安装电脑端

### Windows

1. 在 [Releases](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases) 下载 `Terminal-plus-1.1.12-Setup-x64.exe`。
2. 使用平时运行 CLI 的系统用户打开安装器，点击 **Install**。已包含 Node 和后端依赖，安装本身可离线完成，不需要系统 Node/npm 或管理员权限。
3. 会话管理页自动打开。以后使用桌面／开始菜单快捷方式，或双击托盘图标。
4. 托盘右键显示运行状态，并提供 **Open Terminal+**、**Start with Windows**、更新和 **Quit Terminal+**。Quit 只退出托盘，保留独立后台和原生终端。

默认安装目录是 `%LOCALAPPDATA%\Programs\Even-Pilot`；检测到便携安装时，安装器可能在原目录升级。ZIP 是可选便携版，需完整解压到专用文件夹再运行 `Terminal-plus.exe`，不能只复制一个 EXE。Windows 二进制尚未签名。

### Linux（无头或桌面）

电脑端面向 x64/glibc，实测基准为无头 Ubuntu 26.04 LTS，不适用于 Alpine/musl。以普通用户安装，**不要加 sudo**。

**已有 Node 22+ 和 npm：**

```sh
npm install -g terminal-plus
terminal-plus-setup
```

若 npm 提示 `EACCES`，执行 `npm install -g --prefix "$HOME/.local" terminal-plus`，再执行 `~/.local/bin/terminal-plus-setup`。Setup 在 npm 禁用安装脚本时也能使用；旧版本会升级，相同或更新版本会保留。

**安装器／没有 npm：**从 Releases 下载 Linux `.run`，运行下载的文件，把 `VERSION` 换成它的版本号：

```sh
sh ./Terminal-plus-VERSION-Setup-linux-x64.run
```

两种方式都安装到 `~/.local/lib/even-pilot`，命令位于 `~/.local/bin/terminal-plus`，并为支持的 shell 添加可移除的 PATH 配置。原生电脑端独立于 npm setup 包。首次 npm setup 只部署文件；`.run` 默认启动后台。**新开 shell**，启动监控并打印连接信息：

```sh
terminal-plus
terminal-plus pair
```

原来的 shell 可用 `~/.local/bin/terminal-plus`，或执行 setup 打印的 PATH 命令。无桌面时也能完整管理：

```sh
terminal-plus start
terminal-plus sessions
terminal-plus pair
```

`pair` 只打印 URL/key/Glance 二维码，不负责启动服务器。直接运行 `terminal-plus` 等于 `open`：启动后台、应用桌面最近 24 小时的 Watch 默认规则，然后打开浏览器。无头机器的 `terminal-plus open` 会打印已授权的私有管理链接，在浏览器打开即可，无需手填桌面 URL/key；像 `pair` 输出一样保密。只想查看、不重置默认 Watch 时使用 `sessions`。

systemd 机器要在 SSH 登出后、重启后继续运行：

```sh
terminal-plus autostart on
sudo loginctl enable-linger "$(id -un)"
```

Lingering 是系统用户服务策略，安装器不会擅自开启。没有用户 systemd 时使用独立后台进程；图形登录可用 XDG autostart，无头环境则需自己的进程管理器处理重启自启动。[Linux 细节](linux.md)

无头打开 CLI 需系统 `tmux`，Claude 远程连接器另需 `python3`。安装器不自动安装这两项；Ubuntu/Debian 可执行 `sudo apt install tmux python3`。

## 让已有 CLI 接入

后台必须与 CLI 使用同一个系统用户和配置目录。列表里有历史记录，不代表已经接入实时输入通道。

| CLI | 首次接入 | 远程能力 |
| --- | --- | --- |
| Pi | 已有终端等空闲后 `/reload`；新终端自动加载监控扩展 | 状态、prompt、支持的原生命令和取消 |
| Codex CLI／Codex Desktop 本地会话 | 无需插件或重开；新会话保存第一条 prompt 后被发现 | 普通会话只读；prompt／控制需要连接器 |
| Claude Code | 安装时添加官方监控 Hooks；下一次 prompt 开始监控，用 `/hooks` 检查；未加载时等任务结束后重开 | 普通会话只读；远程输入需要实验 Channel 连接器 |

需要远程输入时，在管理页 **+ New terminal** 选择 **Tunnel** 和已有项目目录，创建连接器会话。Linux 也可以：

```sh
terminal-plus new codex --cwd /your/project --name "My task"
terminal-plus new claude --cwd /your/project
```

替换示例项目路径。Claude 需在原终端确认 **local development channel**，并仍使用原来的工具审批。普通 Claude 只读监控不依赖 Channel；存在可能继续执行的自定义 Stop Hooks 时，完成状态会保持未确认。[完整能力表](connectors.md)

### Pi 多 agent（可选）

监控扩展与 subagent 扩展是两回事。已经加载官方 subagent 示例就直接复用；未安装时：

- Windows 安装器版：按[脚本步骤](pi-extensions.md#第一步添加到-pi-的配置目录)读取 `install.json` 找到当前 payload，脚本在该版本目录内。便携／源码版在解压／checkout 目录使用 `scripts/enable-pi-subagents.ps1`。
- Linux：执行 `terminal-plus enable-pi-subagents`。

然后 Pi 空闲时 `/reload`。脚本获取匹配版本的官方示例，角色继承当前模型和登录；安装后由模型决定何时委派，不会强制每个任务开多个 agent。[验证 prompt 和详细步骤](pi-extensions.md)。未知第三方格式可能只显示 `1+`。

## 先确认网络可达

1. 手机和每台电脑安装 [Tailscale](https://tailscale.com/download)，加入同一 tailnet，或配置彼此访问权限。
2. 获取每台电脑自己的 IPv4，Linux 可执行 `tailscale ip -4`，Windows 在 Tailscale 界面查看。
3. 手机浏览器打开 `http://电脑IP:4317`，应能看到页面，再继续 Hub 配置。
4. 电脑保持开机、不休眠，主机防火墙允许预期私有网络的 TCP 4317。Terminal+ 不自动改防火墙。

地址属于每台电脑，不写死进包。`0.0.0.0` 是监听地址，手机上的 `127.0.0.1` 是手机自己。无需子网路由、出口节点或公网端口转发；互通的 LAN 也能用，支持 Tailscale 内的 HTTP。

显示名优先读取 Tailscale 设备名（例如 `nuc`）；获取不到时显示系统主机名并提示。名称和连接地址是两回事，数字 Tailscale IP 不依赖 MagicDNS。

## 连接 Hub 与多台电脑

1. 在 Even Hub 单独安装 **Terminal+ 1.1.12**（`terminal-plus-1.1.12.ehpk`）。使用 **Terminal+ 1.1.12** 电脑端和 Even App 2.2.10+，再连好 G2。
2. 在需要连接的电脑获取两项：Windows 本机管理页 **Connect phone** 打开 **Connect your phone**，直接显示这台的 URL/key 和二维码；Linux `terminal-plus pair` 打印。
3. 手机 Hub **Connection → Connect another computer** 填写：

   | 字段 | 内容 |
   | --- | --- |
   | Bridge URL | `http://电脑IP:4317`，不要加 `/api` |
   | Connection key | 同一台电脑显示的原始 key，不加 `Bearer` |

4. 点击 **Connect computer**。信息自动保存，下次打开恢复。**Connected computers** 列出保存的设备；**View sessions** 查看会话，**Edit connection** 修改连接。
5. 其他电脑也在手机展开 **Connect another computer**，填各自的 URL/key。设备列表保存在这部手机。每台桌面管理页只连接自己的后台，管理本机的会话。

手机会话按设备分组、按最近更新时间排列。断网保留连接和 Watch，其他电脑继续使用；手机 Remove 只忘记这部手机保存的连接，不停后台或终端。**Glance notifications** 单独设置：手机添加电脑不会注册 watcher，也不会改变通知路由。

### Key 与二维码

| 内容 | 放在哪里 |
| --- | --- |
| Connection key | Hub 连接、管理/API，或 Glance Credential；拥有该电脑控制权限 |
| Firebase 服务账号 JSON | 只给实际发送 FCM 的电脑／中心，不填进 Hub 连接 |
| OpenAI／ElevenLabs 转写 key | 可选的手机 **Voice** 设置，不是模型 key 或 connection key |
| Relay credential | 来源向中心注册时自动生成，只用于转发通知 |

二维码包含电脑 URL 和 connection key。Glance 扫描后可自动得到 `/api/glance`，仍要 **Save and register**。Hub 目前手工填写两项。二维码有访问会话和控制的能力，不要放进公开截图或发布资产。

## Watch 与原生终端

桌面有 **Watched / All sessions**，手机有 **All / Watched / Running** 筛选。Watch 只记录监控；选中 live 会话复用现有连接，选中保存的历史可能打开原生终端。只读观察不会自动变成第二个写入端。

- 显式打开桌面管理页默认 Watch 最近 24 小时更新的会话，不弹出关闭的终端。
- 刷新、后台重启和网络重连不重新应用这个规则。
- 手动 Unwatch 跨后续任务／重连保留；显式选择、远程输入或下次打开桌面可重新启用。
- Unwatch、Quit、停止监控都不杀终端；手动关原终端是连接结束，不等于任务成功完成。

SSH 命令里的 `SESSION` 换成 `sessions` 列出的唯一短 KEY，或用引号包住完整标题：

```sh
terminal-plus sessions
terminal-plus sessions --watched
terminal-plus watch SESSION
terminal-plus unwatch SESSION
terminal-plus select SESSION
```

`select` 打开／复用并 Watch，`new` 新建终端。Linux watcher CLI 不提供发送 prompt 或中断命令。原生交互用：

```sh
tmux ls
tmux attach -t 实际会话名
```

`Ctrl+B` 再按 `D` 脱离，不终止 CLI。[完整命令](linux.md)

## 手机与 G2 操作

手机 **Sessions** 管理会话；**Conversation** 查看消息、折叠工具记录和输入；**G2** 查看预览／诊断。只在支持的连接器提供输入和审批。未支持的 slash 命令与 CLI 菜单回原终端操作。[命令和选择题](connectors.md#phone-commands-and-choices)

| G2 页面 | 操作 |
| --- | --- |
| 会话列表 | 滑动选择；点消息展开；点 **New prompt** 请求输入；双击弹正常退出确认 |
| 展开全文 | 原生滚动；双击回列表；超长文本菜单 **Next part / Previous part** 分段 |
| 输入 | 单击开始／停止录音；长按立即删上一段，持续按每秒一段 |
| 空输入 | 双击直接返回，不发送 |
| 有文字／录音／等待转写 | 双击确认：**Send & exit** 默认、**Exit only** 仅退出；点确认，确认页双击回编辑 |
| 会话菜单 | **Terminate task** 请求支持的取消；**Sessions** 切换可达的已 Watch 会话 |
| 支持的提问 | 原生列表滑动选择，单击选项；**Other / enter answer** 打开输入界面 |

列表顶部统一 **New prompt**，只读会话会提示回原终端输入。工作时下一行显示当前会话的活跃 agent 数，点开查看主任务和连接器实际报告的子 agent 任务／工具快照；缺少详情时明确提示不可用。双击返回列表。再后面最多十条最新消息。浏览期间数量／消息延后更新，保留原生光标；更早历史在手机或电脑。顶部状态包含设备、当前会话数量、Tunnel、模型和标题。

语音是可选项：手机 **Voice** 选择 OpenAI／ElevenLabs，填自己的转写 key 并保存。新建或未指定模型的 OpenAI 配置默认使用 **GPT Transcribe**，流式显示文字；已有明确的 Whisper 选择、provider 和 key 保留。设置在当前设备保存；手机直接向所选服务上传音频，再把完整 prompt 发到目标电脑。[语音和数据流](voice.md)

普通 Claude 会话能显示问题和选项，回答需要专门的连接器会话。支持的连接器提问最多等待五分钟接收远程回答，手机点 **Cancel** 会立即交回原终端。支持的多个问题在手机处理；未支持的格式或多选题保留在原终端。[提问支持范围](connectors.md#phone-commands-and-choices)

## 可选 Glance 通知

未配置推送也能监控。新安装不附带 Firebase 凭据。手机安装兼容的 Glance，按其[安装指南](https://github.com/Liang-Chu/Glance#readme)配置／导入自己的 Firebase 项目，再选择一种方式：

| 方式 | Firebase 设置 | Glance PUSH 注册 |
| --- | --- | --- |
| 每台独立发送 | 每个发送端都配置 | 每台各一个 watcher，各用自己的 URL/key |
| 中心转发 | 只配置中心，其他电脑转发 | 只注册中心 watcher，使用中心 URL/key |

通知按每个已 Watch 会话完成触发，眼镜当前显示的会话在有效查看租约内抑制，其他会话正常通知。只看手机／桌面预览不抑制；断线不算完成。PUSH 使用 FCM，Android 15 分钟轮询限制属于 POLL。

### 1. 配置发送端或中心

使用有权限向**手机 Glance 已配置／导入的同一个 Firebase 项目**发送的服务账号 JSON，放在稳定的私有目录。私钥不是 connection key；安卓 `google-services.json` 只是客户端配置，不能授权后端发送。每位用户使用自己的项目和凭据，无需重编 APK。[凭据前提](glance-push.md)

Linux 发送端／中心：

```sh
terminal-plus settings push direct
terminal-plus settings firebase --credentials /private/glance-sender.json
terminal-plus settings
terminal-plus pair
```

替换为自己的已授权 JSON 路径。命令从 JSON 的 `project_id` 取得发送目标，保存项目和私有文件路径引用，只重启监控、不终止 CLI。目标必须与手机 Glance 的项目一致。`settings firebase clear` 只删保存配置、不删文件；显式 `GOOGLE_APPLICATION_CREDENTIALS`／`EVEN_PILOT_FCM_PROJECT_ID` 环境变量优先，状态会提示。使用跨项目服务账号或 ADC 时，在监控后台／服务的环境中将 `EVEN_PILOT_FCM_PROJECT_ID` 指向手机的目标项目，并授权发送账号访问该项目。

Windows 给现有 `<安装目录>\.local\bridge-config.json` 添加下面两个字段，**保留原 connection keys，不要用这段替换整个文件**：

```json
{
  "firebaseProjectId": "YOUR_FIREBASE_PROJECT_ID",
  "firebaseCredentialsPath": "C:\\Private\\glance-sender.json"
}
```

把 `YOUR_FIREBASE_PROJECT_ID` 替换成手机已导入／配置的项目 ID，路径换成自己的私有服务账号文件。将这两个字段合并到现有文件，保留 connection key。Quit 托盘，按[认证停止后台步骤](development.md#更新已有安装)只停这台监控后台，然后重开快捷方式。仅 Quit 托盘不会重载 Firebase 设置。[Windows 发送端说明](glance-push.md#windows-setup)

### 2. 给 Glance 注册发送端

1. 发送端／中心显示二维码：Windows **Connect phone**，或 Linux `terminal-plus pair`。
2. Glance 扫码，或手填完整 `http://发送端IP:4317/api/glance`，Credential 填同一发送端 connection key。
3. 选择 **PUSH**，**Save and register**。独立发送每台注册一次，中心模式只注册中心。

发送端需保持运行。配置成功或 Firebase 接受不代表手机已显示，最后用真实已 Watch 会话完成验证。换到中心时 URL 和 Credential 一起换，不能沿用旧电脑 key。

### 3. 其他电脑转发到中心

中心配置并注册完成后，选择一种设置方式。手机先在 **Connection** 保存来源和中心，再打开 **Glance notifications**：

1. **Computer** 选择执行任务的来源电脑。
2. **Send notifications** 选 **Through a central computer**。
3. **Central computer** 选择中心设备。
4. **Save notification settings** 保存，其他来源重复。中心本身选择 **Directly from this computer**。下方 **Glance watcher** URL 会对应实际发送端／中心；仍需到 Glance 单独注册该 URL 和它的 key。

也可以在每台来源的桌面设置：打开 **Glance notifications**，选 **Through a central computer**，**Center URL** 填 `http://CENTER_IP:4317`，**Center connection key** 填中心原始 key，再点 **Save notification settings**。只修改本机路由，不把中心加入桌面会话列表。中心控制 key 只用于注册，不由 UI 保存；后台保存专用 relay 凭据。已配置的中心 URL 会预填，不换中心时 key 留空即可。

Linux 来源电脑也可以在 SSH 执行：

```sh
terminal-plus settings push forward --url http://CENTER_IP:4317 --key-file /private/center-key.txt
terminal-plus settings
```

替换中心 IP，私有文件 `center-key.txt` 只放中心原始 connection key，由用户自己创建。Key 不放命令参数；注册后来源保存专用 relay 凭据，不需要 Firebase，也不会把中心控制 key 存进路由配置。

切回独立模式用 `terminal-plus settings push direct`，或 GUI **Directly from this computer → Save notification settings**；这台现在需要自己的 Firebase 和 Glance watcher。仅打开弹窗是读取，明确保存后才修改路由。转发由电脑间完成，不依赖 Hub 常开；不支持转发链或转发给自己。[队列和重试规则](notification-routing.md)

## 更新和移除

已安装的电脑端默认自动检查稳定版本并安装验证通过的更新，已有关闭设置保留。在本机桌面管理页／托盘取消勾选 **Automatic updates**，或执行 Linux `terminal-plus update off` 关闭自动更新，`on` 恢复。想立即安装，可用本机 **Updates**、Windows 托盘 **Check for updates → Update to …** 或 Linux `terminal-plus update`，再用 `terminal-plus update status` 查看。手动 **Check now** 只检查；安装会短暂重启监控，原生终端继续运行。手机 Hub 不提供电脑端更新操作。

**电脑更新不更新手机／G2 应用。**Even Hub 需单独安装它的 `.ehpk`，配合 Terminal+ 1.1.12 电脑端。从 `local.evenpilot.app` 迁移到 `local.terminalplus.app` 时，可能需要新 Hub 条目／重新安装，手机连接和语音 key 不一定迁移；必要时重新填写各电脑已有的 URL/key 和转写 key。电脑端的 Watch 和 Glance 订阅保留在原数据目录；已有连接器等任务结束后重开加载新代码，Pi 可空闲时 `/reload`。[更新细节](updates.md)

Windows 在 **设置 → 应用 → Terminal+** 卸载，Linux `terminal-plus uninstall`。先自行关闭连接中的原生终端，卸载会保护正在使用的连接并保留运行数据。只停 Linux 监控用 `terminal-plus stop`。

npm 安装的版本完成上述卸载后，再执行 `npm uninstall -g terminal-plus` 移除 setup 包；保存的设置保留。

## 常见问题

| 问题 | 先检查 |
| --- | --- |
| 手机浏览器打不开 | 两端 Tailscale 在线、电脑 IP 正确、后台运行、电脑未休眠、防火墙 TCP 4317 |
| 浏览器能开但 Hub fetch 失败 | 当前 Hub 包、纯 origin 无 `/api` 路径、Even App 网络权限；保留完整错误／origin 供诊断 |
| Connection key 被拒绝 | 用当前运行安装的 **Connect phone**／`pair` 获取 key。同一台电脑新装到另一个目录可能生成不同 key；正常原目录更新会保留 |
| Tailscale DNS unavailable | 先用数字 IP 验证，它不需要 MagicDNS |
| 手机在线但 G2 reconnecting | Even App 的 G2／蓝牙连接及 G2 页状态，显示连接与后端连接不同 |
| 新 CLI 不在列表 | 同用户／配置目录、首次保存 prompt、Pi `/reload`、Claude `/hooks`、桌面 **All sessions** 再 Watch |
| Codex／Claude 提示回原终端 | 当前是只读观察；需要远程输入才创建连接器 |
| Linux 找不到命令 | 重开支持的 shell，或用 `~/.local/bin/terminal-plus`，检查 PATH 提示 |
| Linux 打不开终端 | CLI 已安装登录、无头已装 tmux，从能找到 CLI 的 shell 重启后台 |
| Glance 没推送 | Watch、正确发送端/中心、Firebase 权限、PUSH 保存注册、会话没有正显示在 G2 |
| 电脑更新后 G2 没变 | 单独安装 Terminal+ 的 `.ehpk` |

Linux 日志：`journalctl --user -u even-pilot.service`。Windows 启动诊断：`<安装目录>\.local\desktop-startup.log`。普通重连问题不用清运行数据，那里面有 key、主机身份、Watch 和订阅。交给没有历史记忆的操作者／agent 时，请从[运行手册](agent-runbook.md)开始。
