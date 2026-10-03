# Even-Pilot

轻量的 Pi、Codex、Claude Code 会话监控端。桌面管理页只管理本机，手机汇总多台电脑的会话，在手机和 Even G2 查看已 Watch 的内容。继续在 Windows/Linux 的原生 CLI 工作；支持远程输入的会话也能接收手机／G2 prompt。Glance 完成通知是可选功能。

**1.1.5** · Windows 10/11 x64 · Linux x64/glibc · Even App 2.2.10+

[下载](https://github.com/Liang-Chu/Even-Pilot/releases) · [English](README.md) · [发布说明](RELEASE_NOTES.md)

## 先跑通

### 1. 每台需要监控的电脑安装一次

已有 CLI 和模型登录直接复用。Even-Pilot 必须与 CLI 使用同一个系统用户。

- **Windows：**运行 `Even-Pilot-1.1.5-Setup-x64.exe`，点击 **Install**。管理页自动打开；以后双击桌面快捷方式或托盘图标。托盘右键勾选 **Start with Windows** 可登录自启动。
- **Linux／SSH：**下载 Linux 包，在普通用户下运行：

  ```sh
  sh ./Even-Pilot-1.1.5-Setup-linux-x64.run
  ```

  新开一个 shell 后运行 `even-pilot status` 和 `even-pilot pair`；当前终端先用 `~/.local/bin/even-pilot`。离线安装包已包含 Node 和后端依赖，不需要 npm 全局安装。[无头运行与重启自启动](docs/setup.zh-CN.md#linux无头或桌面)

### 2. 接入已有 CLI

| 正常启动的会话 | 首次接入 | 手机／G2 输入 |
| --- | --- | --- |
| Pi | 自动安装监控扩展。已经打开的 Pi 等任务结束后输入一次 `/reload`；以后新开的自动加载。 | 支持 |
| Codex CLI／Codex 桌面 App 本地会话 | 无需插件或重开。刚创建还未保存记录的会话，先发一次 prompt。 | 只读；远程输入需创建连接器会话 |
| Claude Code | 安装时添加官方监控 Hooks，下一次 prompt 开始观察；用 `/hooks` 确认。若未加载，等空闲后重开。 | 只读；远程输入需实验连接器 |

需要连接器时，管理页点击 **+ New terminal**，选择 **Tunnel** 和项目路径。Claude 需在原终端确认 Channel。完整输出及未支持的 CLI 菜单仍在原终端处理。[能力和限制](docs/connectors.md)

### 3. 先让手机能访问电脑

1. 电脑和手机安装 [Tailscale](https://tailscale.com/download)，加入同一个 tailnet，保持连接。
2. 获取**该电脑**的 `100.x.x.x` 地址；Linux 可执行 `tailscale ip -4`。
3. 手机浏览器打开 `http://电脑IP:4317`，应能看到网页；同样可使用能互通的局域网。

不需要子网路由或出口节点。`127.0.0.1` 是当前设备自己，`0.0.0.0` 是监听地址，都不能作为手机连接电脑的地址。[连接排查](docs/setup.zh-CN.md#常见问题)

### 4. 手机 Hub 单独安装并保存连接

1. 在 Even Hub 安装／上传 `even-pilot-1.1.5.ehpk`，在 Even App 连好 G2。
2. Windows 点击 **Connect phone** 查看这台电脑的手机连接信息；Linux 运行 `even-pilot pair`。
3. 手机 Hub 打开 **Connection → Connect another computer**，填入该电脑的 **Bridge URL**、**Connection key**，点击 **Connect computer**。Key 只填原值，不加 `Bearer`。
4. 连接保存在这部手机。其他电脑也在手机按相同步骤填写各自的 URL/key，手机统一查看；每台桌面管理页只显示本机。

二维码供 Glance 等支持扫码的应用使用；Hub 目前手工填写两项。添加电脑不会自动配置 Glance 通知。[多设备和 key 的区别](docs/setup.zh-CN.md#连接-hub-与多台电脑)

### 5. 勾选 Watch，再打开 G2

在 **Sessions** 找到会话并开启 **Watch**；桌面看不到时切换 **All sessions**。G2 默认回到上次可用的已 Watch 会话，Sessions 只显示已 Watch 且可连接的会话。

- Watch 不开终端；Unwatch 不关闭终端、不打断任务。
- 选择保存的会话可打开原生终端。每次显式打开桌面管理页，默认 Watch 最近 24 小时更新的会话；刷新或重连不重置 Watch。
- 手动 Unwatch 会跨后续任务和断线保留；显式选择／远程输入可重新启用 Watch。
- 退出 Windows 托盘、停止监控后台都保留原生终端。后台停着时无法保证观察到全部完成事件。

## 常用操作

G2 是原生列表：顶部 **New prompt**，工作时下一行显示当前会话的活跃 agent 数，再下面是最近十条消息。滑动选择、点消息展开全文，双击返回列表；列表双击正常退出并确认。终止当前任务放在菜单 **Terminate task**，需要支持控制的连接器。[操作说明](docs/setup.zh-CN.md#手机与-g2-操作)

语音可选：手机 **Voice** 保存自己的 OpenAI／ElevenLabs 转写 key。单击开始／停止录音，长按每秒删除上一段。空草稿双击直接返回；有内容时选择 **Send & exit** 或 **Exit only**。[语音详情](docs/voice.md)

Pi 多 agent 可选：已有官方 subagent 示例直接复用，否则 Linux 执行 `even-pilot enable-pi-subagents`，Windows 按[脚本步骤](docs/pi-extensions.md#第一步添加到-pi-的配置目录)，然后 Pi 空闲时 `/reload`。它与基础监控扩展不同。[安装验证](docs/pi-extensions.md)

Glance 推送可选：每台电脑独立发送就分别配置；集中发送就只给中心配置 Firebase 和 Glance PUSH，其他电脑转发到中心。[完整配置](docs/setup.zh-CN.md#可选-glance-通知)

## 更新

Windows 托盘 **Check for updates → Update to …**；Linux `even-pilot update`，`even-pilot update off` 关闭自动检查。管理页 **Updates** 也可操作。安装需主动点击，保留连接和 Watch，原生终端继续运行。

**电脑端更新不会更新手机 Hub。**请单独在 Even Hub 安装对应版本的 `.ehpk`。[更新详情](docs/updates.md)

## 完整说明

- [首次安装、配置、连接及排查](docs/setup.zh-CN.md) / [English setup](docs/setup.md)
- [无历史记忆的操作者／agent 运行手册](docs/agent-runbook.md)
- [文档目录](docs/README.md)、[API](docs/api.md)、[源码构建](docs/development.md)
- [审计和已知限制](docs/release-status.md)、[发布步骤](docs/publishing.md)

Linux 本包要求 x64/glibc，不覆盖 ARM64 或 Alpine/musl。Windows 二进制未签名。Claude 仍为实验支持；自动测试通过不等于已完成眼镜、语音或推送的真机验收。
