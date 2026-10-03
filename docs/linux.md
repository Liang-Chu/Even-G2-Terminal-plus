# Linux 安装和运行

首次部署按[完整安装连接指南](setup.zh-CN.md)操作；没有历史记忆的操作者／agent 从[运行手册](agent-runbook.md)开始。本页保留 Linux 命令和服务的详细参考。

1.1.8 的发布包面向 **x86_64 / glibc Linux**，内置官方 Node 24 运行时和生产依赖。历史版本 1.1.0 的实测基准为 **Ubuntu 26.04 LTS、x86_64、无图形桌面、tmux 3.6**；本次补丁的验证结果见[发布状态](release-status.md)。安装不依赖 apt/rpm、不需要 sudo，不安装全局 Node、不修改 CLI 登录；为支持的用户 shell 添加可安全移除的 PATH 配置。

发行版仍需能运行官方 Node Linux 二进制；Alpine/musl 不适用此预编译包。ARM64 构建脚本可在对应 Linux 主机运行，但当前未进行 ARM64 实机验收。GNOME、KDE、XFCE、Kitty、xterm 的启动参数有回归测试；NUC 没有图形桌面，不能代替这些桌面的实机验收。

## 1. 安装

已有 Node 22+ 和 npm 时，在普通用户的终端里执行，不用 `sudo`：

```sh
npm install -g even-pilot
even-pilot-setup
```

`even-pilot-setup` 完成本机安装；npm 跳过安装脚本时仍可使用。相同或更新的电脑端已安装时跳过，旧版本则升级并重启监控。npm 包只支持 Linux x64/glibc，包含经过校验的安装器，不依赖 GitHub 下载。首次 npm 安装只部署文件，接着新开 shell 运行 `even-pilot` 才启动监控。

若 npm 提示 `EACCES`，改为 `npm install -g --prefix "$HOME/.local" even-pilot`，接着执行 `~/.local/bin/even-pilot-setup`；不使用 sudo。

没有 npm 时从 [Releases](https://github.com/Liang-Chu/Even-Pilot/releases) 下载 `.run`，在普通用户下执行，把 `VERSION` 换成下载文件的版本号。当前已发布版本见 [README](../README.zh-CN.md)：

```sh
sh ./Even-Pilot-VERSION-Setup-linux-x64.run
```

安装本身可离线完成。默认应用目录 `~/.local/lib/even-pilot`，启动命令 `~/.local/bin/even-pilot`；应用菜单里也有 Even-Pilot。安装后新开的 Bash、Zsh、Fish 或支持的 POSIX 登录 shell 可直接输入 `even-pilot`。当前终端先用完整路径，或执行 `export PATH="$HOME/.local/bin:$PATH"`；自定义 bin 目录按安装器输出添加。安装器保留用户自己的 shell 内容，遇到链接／不支持的 shell 会提示手工设置。`.run` 默认安装后自动启动后台；有图形桌面时打开浏览器，否则打印手机／电脑可访问的地址。

自定义目录：`sh ./Even-Pilot-VERSION-Setup-linux-x64.run --dir /your/path`。不立即启动：追加 `--no-start`。已安装的电脑端默认每天检查稳定版本并自动安装验证通过的更新；`even-pilot update off` 关闭，`on` 恢复，已有关闭设置保留。`even-pilot update` 立即更新，`update check` 只检查，`update status` 查看结果。也可下载新 `.run` 后执行 `sh ./文件名.run`，**不使用 `npm update`**。安装器保留 connection key、Watch 和推送设置，并重启监控后台；保留旧版本文件供已打开的终端继续使用。待任务结束后重开连接器，Pi 可在空闲时 `/reload`。[更新详情](updates.md)

运行环境可用时支持直接解压 `.tar.gz` 到专用文件夹，再运行 `./bin/even-pilot open`；不把便携文件覆盖到正在运行的版本目录。

## 2. 接入 CLI

已有并已登录的 CLI 不需要重装或重复填 key。没有的按各工具自己的 Linux 文档安装、登录：

- [Pi 官方说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)：安装 Node 后执行 `npm install -g @earendil-works/pi-coding-agent`，运行 `pi` 完成模型配置。
- [Codex CLI 官方说明](https://learn.chatgpt.com/docs/codex/cli)：也可使用 `npm install -g @openai/codex`，运行 `codex` 登录。
- [Claude Code 官方说明](https://code.claude.com/docs/en/quickstart)：使用官方 Linux 安装方式，运行 `claude` 登录。Claude 的 Linux 连接器使用 Python 3 标准库，不需要 pip 包。

Pi 监控扩展会自动安装，新 Pi 自动加载；已有 Pi 等任务结束后 `/reload`。普通 `codex` 自动进入只读监控和完成通知。需要从手机／G2 发 prompt 时，从网页管理页新建对应连接器终端，或用会话管理命令新开独立原生终端：

```sh
even-pilot new codex --cwd /your/project
even-pilot new claude --cwd /your/project
```

普通 `claude` 通过安装时添加的官方 Hooks 接入只读监控，下一次 prompt 开始报告状态；`/hooks` 可确认已加载。已有窗口若未加载，等任务结束后再重开。普通监控无需 Channel；需要远程输入时使用上面的连接器终端，并接受原生终端的 Channel 确认。安装保留其他 Claude 设置，卸载只移除自身登记的 Hooks；存在已知自定义 Stop Hooks 时，完成状态保留为未确认。完整对话和需要原生菜单的操作仍在终端中进行。三个 CLI 的功能边界见[连接器说明](connectors.md)。CLI 安装后若后台找不到命令，在能运行该 CLI 的 shell 执行 `~/.local/bin/even-pilot restart`，更新后台 PATH；也可设置 `EVEN_PILOT_PI`、`EVEN_PILOT_CODEX`、`EVEN_PILOT_CLAUDE` 为实际程序路径。

已有受支持的官方 Pi subagent 示例无需重装；尚未启用时执行 `~/.local/bin/even-pilot enable-pi-subagents`，再在空闲的 Pi 中 `/reload`。它联网下载与已安装 Pi 版本匹配的官方示例，已有自定义文件冲突时拒绝覆盖。基础监控无需此扩展；脚本不重新登录、不填写模型 key、不自动重载工作中的 Pi。

## 3. 无桌面 / NUC

管理页是浏览器网页，NUC 本身无需安装图形桌面或浏览器。日常管理也可以全部通过 SSH 命令行完成。
本机命令自动读取已保存的 connection key，不需要每条命令重新输入；`pair` 才会显式显示 URL、key、Glance URL 和二维码。Glance 可扫码后保存注册，无需手抄。集中转发时在中心服务器运行 `pair`；终端窗口需足够宽，以免二维码换行。

`pair` 只打印，不会启动后台。无参数 `even-pilot` 相当于 `open`，会启动管理页并应用最近 24 小时默认 Watch。无头机器的 `even-pilot open` 打印已授权的私有管理链接，浏览器打开即可，无需手填桌面 URL/key；链接像 `pair` 输出一样保密。`sessions` 只是查询，不重置 Watch。

先启动监控、查看配对信息和会话：

```sh
~/.local/bin/even-pilot start
~/.local/bin/even-pilot pair
~/.local/bin/even-pilot sessions
```

以下例子中的 `abc12345` 替换成列表里的 KEY，也可以使用带引号的完整会话标题；短 KEY 必须唯一，重名会拒绝操作。会话按最近更新排序，显示 Watch、状态、Tunnel、模型和标题。列表查询不改变 Watch。

```sh
~/.local/bin/even-pilot watch abc12345
~/.local/bin/even-pilot unwatch abc12345
~/.local/bin/even-pilot select abc12345
~/.local/bin/even-pilot new codex --cwd ~/project --name "My task"
```

`watch` 只监控，`unwatch` 只取消监控，两者都不打开或关闭终端。`select` 才打开或复用终端并选中会话；`new` 创建独立原生终端。自 1.1.0 起，Linux CLI 仅提供监控、管理和设置，已移除 `send`、`interrupt`、`terminal` 包装命令；实际 prompt 在原生终端或受支持的手机／G2 页面输入。

`sessions --watched` 只列已 Watch；`sessions --json` 输出完整 key，便于脚本调用。`even-pilot --help` 查看全部命令。自己的 Pi/Codex 仍用原本的 `pi`／`codex` 启动；如需断开 SSH 后继续，先进入自己的 tmux 会话。

安装发行版提供的 `tmux`；Ubuntu/Debian 可执行 `sudo apt install tmux python3`。这两个工具由系统管理，Even-Pilot 安装器不会自动提权安装。

网页打开的新终端保存在可见的 tmux 会话里：

```sh
tmux ls
tmux attach -t pilot-pi-对应编号
```

用 `Ctrl+B` 后按 `D` 脱离 tmux，CLI 保持工作。关闭 CLI 或该 tmux 会话则断开连接；断开、SSH 波动、Unwatch 不表示任务完成。不要用 `tmux kill-server` 关闭某一个会话，它会影响其它工作。

### 推送与 Firebase 设置

```sh
even-pilot settings
```

选择其中一种推送方式。独立发送端（或集中发送的中心服务器）在本机配置 Firebase：

```sh
even-pilot settings push direct
even-pilot settings firebase --credentials /private/firebase-service-account.json
```

只负责转发的电脑使用中心地址和 key，不需要本机 Firebase：

```sh
even-pilot settings push forward --url http://CENTER_IP:4317 --key-file /private/center-key.txt
```

独立发送时在本机配置 Firebase；集中发送时只在中心配置。JSON 必须是你在 Glance 导入的 Firebase 项目的有效服务账号凭据，并具有发送权限；命令从 JSON 读取并保存项目 ID。手机端导入和注册步骤见 [Glance 指南](https://github.com/Liang-Chu/Glance#readme)。先在发送端或中心运行 `even-pilot pair`，用 Glance 扫码、保存并注册 PUSH watcher，再让其他电脑选择 `push forward`。`center-key.txt` 只放中心的 connection key，命令不会把 key 放在参数或输出里。

`settings firebase` 保存凭据文件引用并重启监控后台，不复制私钥、不终止原生 CLI。保持文件可读且位于私有目录；`settings firebase clear` 只移除引用，不删除 JSON 文件。显式 `GOOGLE_APPLICATION_CREDENTIALS` 或 `EVEN_PILOT_FCM_PROJECT_ID` 环境变量会覆盖保存设置，状态会提示。详细步骤见[通知转发](notification-routing.md)。

## 4. 后台、自启动与卸载

```sh
~/.local/bin/even-pilot status
~/.local/bin/even-pilot stop
~/.local/bin/even-pilot start
~/.local/bin/even-pilot autostart on
~/.local/bin/even-pilot autostart off
```

有 systemd 用户管理器时使用用户服务。服务只控制监控后台，停止／升级后台不关闭原生终端。无 systemd 时自动使用独立后台进程，图形登录自启动使用 XDG autostart；无 systemd 的无桌面机器可将 `even-pilot start` 加入自己的用户服务管理方式。

在 systemd 服务器上，若希望最后一个 SSH 登出后仍运行，并且重启后无需先登录：

```sh
sudo loginctl enable-linger "$(id -un)"
~/.local/bin/even-pilot autostart on
```

这改变的是该用户的系统登录策略，不由安装器擅自启用。有图形桌面的登录自启动通常无需这一步。查看后台日志：`journalctl --user -u even-pilot.service`。

卸载：`~/.local/bin/even-pilot uninstall`。先自行关闭连接中的 CLI；检测到仍使用安装文件的终端时会拒绝卸载。连接 key、Watch 和通知订阅默认保留在 `~/.local/share/even-pilot`，也遵循 `XDG_DATA_HOME` 或 `EVEN_PILOT_DATA_DIR`。不要分享这个数据目录。

通过 npm 安装时，完成上面的卸载后再执行 `npm uninstall -g even-pilot`，移除 setup 命令。仅卸载 npm 包不会停止或移除独立安装的监控端。电脑端自动更新继续使用 GitHub Releases，无需同步更新 npm 包；重新运行 setup 也不会降级已安装的更新版本。

## 5. 手机、Even Hub 和 Glance

两端登录 Tailscale 后，在 Linux 执行 `~/.local/bin/even-pilot pair`，在手机 Hub **Connection → Connect another computer** 填入输出的 Bridge URL 和 connection key，点击 **Connect computer**。使用 **Linux 这台机器**的地址与 key，不能沿用 Windows 的地址；连接保存在当前手机。其他电脑也在手机添加，手机汇总会话；桌面管理页只管理提供该页面的电脑。添加设备不会自动配置通知。默认 TCP 4317；`EVEN_PILOT_PORT` 可修改端口，随后重新启动监控。

运行 `even-pilot open` 获取管理入口：有桌面环境时自动打开已授权的本地管理页；无头时复制它打印的完整私有链接到浏览器。桌面管理页自动连接自己的后台，不需要另填 URL/key。地址优先选择本机 Tailscale IPv4，不写死任何用户的 IP。

Glance 继续使用同一套接口和 connection key，按 [Glance 指南](https://github.com/Liang-Chu/Glance)配置。Linux 包不含任何 Windows 凭据或 Firebase 私钥；要从另一台 Linux 主机发送 FCM，按[推送配置](glance-push.md)配置该主机的发送凭据。
