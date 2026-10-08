# Terminal+

通过手机 Even Hub 和 Even G2 查看 Windows/Linux 上运行的 Pi、Codex、Claude Code 会话。继续使用原生终端工作；每台电脑运行轻量监控端，手机汇总它们已 Watch 的会话。

查看来源设备、模型、上报的运行 agent 数和最近消息。可选功能包括逐句语音输入、agent 任务详情，以及通过 Glance 发送完成通知。

**Terminal+ 1.1.13** · Windows 10/11 x64 · Linux x64/glibc · Even App 2.2.10+

[Windows／Linux／Hub 下载](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases) · [Linux npm](https://www.npmjs.com/package/terminal-plus) · [English](README.md) · [完整配置](docs/setup.zh-CN.md)

Windows/Linux 电脑端和手机／G2 应用统一名为 **Terminal+**。命令和文件名在不适合使用 `+` 时使用 `terminal-plus`／`Terminal-plus`。本文面向 **1.1.13**；验证和发布情况见[发布状态](docs/release-status.md)。

## 先跑通

### 1. 安装电脑端

先确保 Pi、Codex 或 Claude Code 已安装并能正常使用。每台需要监控的电脑安装一次 Terminal+，必须与 CLI 使用**同一个系统用户**。继续使用已有模型登录；Terminal+ 不安装 CLI 本体。

- **Windows：**在 [Releases](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases) 下载 `Terminal-plus-1.1.13-Setup-x64.exe`，运行并点击 **Install**。管理页自动打开；以后使用 **Terminal+** 快捷方式或双击托盘图标。不需要系统 Node/npm。
- **Linux／SSH：**下载 `Terminal-plus-1.1.13-Setup-linux-x64.run`，在普通用户下执行，不用 `sudo`：

  ```sh
  sh ./Terminal-plus-1.1.13-Setup-linux-x64.run
  ```

  **新开 shell** 后执行 `terminal-plus` 和 `terminal-plus pair`。当前终端先用 `~/.local/bin/terminal-plus`。安装器包含自己的 Node 运行时和后端依赖。

  **npm 替代方式：**已有 Node 22+ 和 npm 时执行：

  ```sh
  npm install -g terminal-plus
  terminal-plus-setup
  ```

  Setup 部署电脑端；随后**新开 shell**，启动监控并打印连接信息：

  ```sh
  terminal-plus
  terminal-plus pair
  ```

  SSH 无头机器也能使用。npm 跳过安装脚本时 setup 仍可完成安装；已安装相同或更新版本时会保留。若 npm 提示 `EACCES`，改用当前用户的目录：

  ```sh
  npm install -g --prefix "$HOME/.local" terminal-plus
  ~/.local/bin/terminal-plus-setup
  ```


自启动：Windows 托盘勾选 **Start with Windows**；Linux 按[无头服务配置](docs/setup.zh-CN.md#linux无头或桌面)。

### 2. 接入 CLI

| CLI | 首次接入 | 手机／G2 输入 |
| --- | --- | --- |
| Pi | 自动安装监控扩展。已有终端等任务结束后输入一次 `/reload`。 | 支持 |
| Codex CLI／Codex 桌面 App 本地会话 | 自动观察；新会话保存第一次 prompt 后出现。 | 普通会话只读 |
| Claude Code（实验支持） | 安装时添加监控 Hooks。用 `/hooks` 确认；下一次 prompt 开始观察。未加载时等空闲后重开。 | 普通会话只读 |

Claude 监控只读取大 transcript 的有限开头和最近尾部。已确定退出且无法恢复首条 prompt 的旧事件可移出队列；缺失历史不会被当成任务完成。完整历史仍保留在原生 CLI。

Codex／Claude 要远程输入，需在管理页 **+ New terminal** 创建连接器会话，选择 **Tunnel** 和项目路径。Claude 还需在原终端确认 Channel。无头 Linux 需要 `tmux`；Claude 的 Linux 连接器另需 `python3`。[Linux 前提](docs/setup.zh-CN.md#linux无头或桌面) · [能力和限制](docs/connectors.md)

### 3. 连接手机

1. 通过互联网访问电脑时，手机和电脑都安装 [Tailscale](https://tailscale.com/download)，加入同一个 tailnet 并保持连接。能互通的局域网也可以。
2. 在 Even Hub 单独安装 **Terminal+ 1.1.13**（`terminal-plus-1.1.13.ehpk`），再在 Even App 连好 G2。使用 **Terminal+ 1.1.13** Windows/Linux 电脑端。
3. 获取该电脑的 URL/key：Windows 点击 **Connect phone**；Linux 运行 `terminal-plus pair`。
4. 手机应用打开 **Connection → Connect another computer**，填入 **Bridge URL** 和 **Connection key**，点击 **Connect computer**。

使用 **Connect phone**／`pair` 打印的可达 URL，如 `http://电脑的TailscaleIP:4317`。Key 填原值，不加 `Bearer`，请保密。手机自动保存连接；其他电脑按相同步骤添加。保持电脑端运行，电脑不要休眠。Linux 的 `pair` 只打印信息；`terminal-plus` 才启动监控。

每台桌面管理页只管理本机。Hub 手工填写 URL/key，二维码供 Glance 使用。连接失败时先用手机浏览器打开 Bridge URL。[连接排查](docs/setup.zh-CN.md#常见问题)

### 4. 选择会话

在 **Sessions** 开启 **Watch**，再打开 G2 应用。G2 回到上次可用的已 Watch 会话，列表只显示已 Watch 且可连接的会话。桌面找不到时，切换 **All sessions**。

- Watch 不打开终端；Unwatch 不停止任务、不关闭终端。
- 打开桌面管理页默认 Watch 最近 24 小时更新的会话；刷新／重连不重置 Watch。手动 Unwatch 跨后续任务和断线保留。
- 选择保存的会话可打开终端。退出托盘、停止监控都保留原生终端。

[会话管理](docs/setup.zh-CN.md#watch-与原生终端)

验证连接：在已 Watch 的原生 CLI 会话运行一个短任务，手机和 G2 应看到新消息及运行／空闲状态。测试 Glance 完成通知时，先在 G2 退出 Terminal+ 再运行任务；正在查看的会话会抑制自己的通知。

## G2 操作

滑动选择，点消息展开，点运行 agent 行查看可用任务详情。G2 显示最近十条消息。展开页双击返回；会话列表双击正常退出并确认。菜单 **Terminate task** 请求终止当前任务，需要支持控制的会话。

[完整操作](docs/setup.zh-CN.md#手机与-g2-操作)

## 可选功能

### 逐句语音输入

在手机 **Voice** 保存自己的 **OpenAI API key** 或 **ElevenLabs key**。新建或未指定模型的 OpenAI 配置默认使用 **GPT Transcribe**，流式显示文字；已有 provider、key 和明确保存的 Whisper 选择继续保留。ChatGPT 订阅本身不提供 API 访问；手机需要能访问语音服务的互联网连接。

在支持输入的会话打开 **New prompt**。单击开始／停止一句录音，再次录音追加下一句。长按删除上一段，持续按住每秒删除一段。空草稿双击返回；有内容时选择 **Send & exit** 或 **Exit only**。[语音设置与操作](docs/voice.md)

### Pi 多 agent

已有官方 Pi subagent 扩展直接复用。否则 Linux 运行 `terminal-plus enable-pi-subagents`，Windows 按[脚本步骤](docs/pi-extensions.md#第一步添加到-pi-的配置目录)，然后在 Pi 空闲时 `/reload`。此可选工具与基础监控扩展不同。[安装验证](docs/pi-extensions.md)

### Glance 完成通知

Android 安装 [Glance](https://github.com/Liang-Chu/Glance)，接收每个会话的完成推送。选择一种发送方式：

| 方式 | Firebase 凭据 | Glance PUSH 注册 |
| --- | --- | --- |
| 每台电脑独立发送 | 每台发送电脑配置 | 每台发送电脑一个 watcher |
| 一个中心统一发送 | 只给中心配置，其他电脑转发到中心 | 只注册中心一个 watcher |

在电脑端 **Glance notifications** 设置发送方式，再用发送端／中心的二维码或 URL/key 在 Glance 注册。Hub 保存电脑连接不会自动注册 Glance。G2 正在查看的会话不发送自动完成通知。

[电脑端和转发配置](docs/setup.zh-CN.md#可选-glance-通知)

## 更新

1.1.13 的 Claude 监控修复只需更新电脑端。已有 Terminal+ Hub 继续兼容；此修复不要求更新手机／G2 应用。

**从 Even-Pilot 升级：**先手工运行一次新版 Terminal+ 安装器。仓库更名后，旧更新器可能无法完成更新。为保留 connection key、Watch 和通知设置，安装／数据／服务目录及 `EVEN_PILOT_*` 配置继续兼容原名称。[迁移和更新指南](docs/updates.md#migration-from-even-pilot)

完成这次升级后，电脑端默认自动安装验证通过的稳定更新。可在该电脑取消 **Automatic updates**，或运行 Linux `terminal-plus update off`；`on` 恢复。立即更新用 Windows 托盘／管理页，或 Linux `terminal-plus update`。

**手机／G2 应用单独更新**：在 Even Hub 安装它的 `.ehpk`。从旧 Hub app ID 迁移时可能需要重新安装；必要时重新填写手机保存的电脑连接和语音 key。电脑端更新保留 Watch，原生终端继续运行。[更新指南](docs/updates.md)

npm 安装的电脑端使用同一个自动更新器，无需运行 `npm update`。卸载时先 `terminal-plus uninstall`，再 `npm uninstall -g terminal-plus`；保存的设置保留。[Linux 命令参考](docs/linux.md)

## 更多说明

[无历史记忆的操作者／agent 手册](docs/agent-runbook.md) · [文档目录](docs/README.md) · [源码构建](docs/development.md) · [发布步骤](docs/publishing.md)

Claude 是实验支持。Linux 要求 x64/glibc，不覆盖 ARM64 或 Alpine/musl。Windows 二进制未签名。[审计证据和已知限制](docs/release-status.md)
