# 更新与源码构建

安装用户先看[安装连接指南](setup.zh-CN.md)；接手已有环境的操作者／agent 先看[运行手册](agent-runbook.md)，确认安装目录、数据和后台归属，再执行以下维护命令。

## 更新已有安装

Windows 安装器用户：再次运行新版 **Setup-x64.exe**，点击 **Install** 即可。安装器只关闭该目录的托盘和原生监控后台，不终止 CLI；新代码存放在 `versions/<版本>-<内容标识>`，`.local` 保持在安装根目录。原生终端可继续使用旧版本文件，等任务完成后再重开／Pi `/reload`。整个安装过程不需要 npm、系统 Node 或管理员权限。Linux 再次执行新版 `.run`，详见 [Linux 更新](linux.md)。

以下手动步骤仅用于便携版或源码目录：

1. 保留整个 `.local` 目录。它包含本机 key、Watch 设置和推送订阅；不要把它放进分发包。
2. 右键托盘选择 **Quit Even-Pilot**。这只退出托盘，不会停后台或原生终端。
3. 在旧安装目录打开 PowerShell，停止该安装的原生监控后台。默认配置可执行以下命令；使用自定义数据目录、token 或端口时相应调整。停止期间不记录新的任务完成通知。

```powershell
$pilotConfig = Get-Content -Raw .local/bridge-config.json | ConvertFrom-Json
$pilotHeaders = @{ Authorization = "Bearer " + $pilotConfig.controlToken }
$pilotState = Invoke-RestMethod http://127.0.0.1:4317/api/monitoring -Headers $pilotHeaders
if ($pilotState.nativeTerminals -ne $true) { throw 'This is not the native monitoring backend.' }
Invoke-RestMethod http://127.0.0.1:4317/api/shutdown -Method Post -Headers $pilotHeaders
```

4. 等后台退出后，将新 ZIP 内的文件覆盖到同一安装目录，保留 `.local`，再运行 **Even-Pilot.exe**。ZIP 已包含运行环境。不要在同一端口启动第二套安装；由此目录启动的原生连接器应在任务结束后关闭再手动覆盖，自动安装器则会保留它们使用的旧版本目录。
5. 上传安装配套的新 Hub 包。现有 Pi 等空闲时输入 `/reload`；连接器终端在任务结束后重开以加载新代码。普通 Codex 只读监控无需重开；普通 Claude 在下一次 prompt 接入新 Hooks，可用 `/hooks` 确认，未加载时等任务结束再重开。

更新后台不会替用户关闭正在工作的终端。确认正在使用本项目的发布 ZIP；这个文件夹中的缓存、日志或个人配置不应直接打包分享。

## 源码构建

以下开发命令需要源码 checkout。Windows ZIP 只包含运行所需代码、前端构建产物和文档，不包含测试、模拟器、构建脚本或开发依赖。

在项目根目录执行：

```powershell
npm ci
npm run build
npm run desktop:build
npm run desktop
```

开发页面：`npm run dev`（5173）。仅启动原生监控后台：`npm start`。
`npm run terminal:codex -- --cwd "C:\your\project"` 和 `npm run terminal:claude -- --cwd "C:\your\project"` 从命令行启动对应连接器。

## 验证和打包

```powershell
npm run check
npm run desktop:test
npm audit
npm run release:build
```

`release:build` 创建 `outputs/releases/<版本>-<随机后缀>`，包含 Windows 安装 EXE、便携 ZIP、Hub EHPK、文件清单和 SHA-256 校验和。构建使用 Windows 自带的 .NET Framework 编译器，将当前官方 Windows x64 Node 运行时、许可证和锁定的生产依赖嵌入安装器；Node 二进制必须匹配官方 SHASUMS256。构建需要联网或已有依赖／校验文件缓存，用户安装时无需联网。只复制白名单源文件，阻止 `.local`、Firebase 私钥和当前 connection key 进入分发包。它生成暂存 EXE，不替换正在运行的根目录 EXE。

Linux 在原生 Linux x64/arm64 上构建：`npm ci --ignore-scripts`、`npm run check`、`npm run release:linux`。将与构建 Node 完全一致的官方 `node-v<版本>-linux-<架构>.tar.xz` 放在 `outputs/toolchain`；脚本按官方 SHASUMS256 验证归档，并将新解压的 Node 与构建进程二进制比较。输出离线 `.run`、便携 `.tar.gz` 和 SHA-256 校验和；用户端不执行 npm install。

对实际 Linux 安装包执行 `node tests/linux-installer-smoke.mjs <Setup.run>`，以及追加 `--systemd` 的用户服务测试；设置 `EVEN_PILOT_PI` 指向隔离安装的官方 CLI，可同时测试真实 Pi TUI、tmux、Unwatch 和停止后台后的存活。`tests/linux-codex-smoke.ts` 使用 `EVEN_PILOT_CODEX` 验证真实 App Server 初始化和空会话读取，不发送模型请求。Linux 的 ARM64 包需要在 ARM64 主机单独构建和验收，x64 NUC 结果不能代替。

对刚生成的目录运行 `node tests/release-smoke.mjs "<发布目录>"` 和 `node tests/installer-smoke.mjs "<发布目录>"`。前者检查便携包；后者验证真正的安装 EXE、无系统 Node/npm 的启动、Windows 卸载注册、重装保留 key、升级保留工作进程、卸载保护以及保留数据。均使用隔离目录，不读取实际 CLI 历史或运行付费模型任务。


代码目录：`apps/windows` 为托盘/API/CLI 扩展；`apps/linux` 为 Linux 安装、服务和终端适配；`apps/evenhub` 为手机和 G2；`packages` 为状态和连接器。SDK、字体许可见 [THIRD_PARTY_NOTICES](../apps/evenhub/THIRD_PARTY_NOTICES.md)。版本修改需同步 package.json、lockfile、Hub manifest、Tray.cs、Installer.cs、安装器 manifest、连接器握手版本和发布文档。

## 发布文件与私有文件

`release/1.1.8/` 是准备上传的文件夹：Windows EXE/ZIP、Linux RUN/TAR.GZ、Hub EHPK、`SHA256SUMS.txt` 和简短发布说明。安装器和便携包已包含用户文档；源码、测试和构建脚本随仓库发布，详细本机测试日志和文件清单留在 `outputs/`。

`.gitignore` 排除生成包、依赖、编译产物、日志、`.local`、环境文件、服务账号 JSON 和私钥。它不保护 Git 已跟踪的文件，也不是脱敏工具；首次发布前检查待提交清单，保留 `package-lock.json`、源代码、测试、图标/字体及许可。不要直接打包整个开发文件夹。

## G2 显示与兼容诊断

当前会话页使用原生单列列表：输入行在最上方，统一显示 New prompt，只读会话也保留此标签，但不改变其输入权限。当前会话有活跃 agent 时紧接着显示数量行，再后面最多十条最新消息。两种箭头均在左侧：agent 使用 ←，用户使用 →。列表和 itemWidth 均为 560 px，标签按字体的 544 px 可用宽度和官方 64 字符上限截断，结尾加 ...。混合页面保留一个静态原生文字容器，列表仍是唯一事件捕获控件。只有同一布局缩短标签后被接受，才保留 63 UTF-8 字节的 compact labels 限制；若这次重试仍失败，原生 basic view 会重新尝试完整宽度。此前报告不足以证明固件统一采用字节上限。文字状态栏独立按像素裁切，不使用列表字节限制。

对照实现：[Even Transit](https://github.com/langerhans/even-transit/blob/main/src/pages/results.ts)、[eveng2-demo](https://github.com/bigdra50/eveng2-demo/blob/main/src/pages/list.ts) 都使用原生列表和文字容器；它们的 itemWidth 为 566 或 560 px。[G2CC 的作者实测记录](https://github.com/expectbugs/G2CC/blob/master/docs/G2_BLE_PROTOCOL.md) 也描述了原生文字区域对页面绘制的作用，但这不是 SDK 对所有设备的保证。

`npm run build` 生成桌面/浏览器通用的 `apps/evenhub/dist`；`npm run build:hub` 生成 `apps/evenhub/dist-hub`，编译时排除桌面专用会话管理、配对弹窗和 CSS。`npm run pack:evenhub` 只打包后者。会话管理模块按需导入，语音设置弹窗第一次打开时创建，已保存的 key 仍在启动时恢复。固定版本 @evenrealities/pretext 0.1.4 的字形、范围和字距表在构建时无损压缩，测量函数保持上游实现；测试逐项比对解码表和测量结果，许可保留。

列表捕获事件，原生固件负责滑动、高亮；不依赖逐次滑动回调。点击索引映射到已挂载快照中的消息，展开后由单个文字容器原生滚动。已移除气泡布局、隐藏列表和自绘光标。尚未连接会话时显示连接提示；空快照不阻止第一批历史加载，收到历史后自动重建一次。停在输入行时，新消息每两秒合并更新；列表浏览、全文阅读和编辑期间冻结消息和活跃数量快照，显示 +new，从全文／编辑页返回时读取最新值。菜单不提供 Refresh messages 或 New prompt。这样不会通过重建列表重置用户正在操作的原生焦点。列表接口不支持就地更新行或设置选中位置，见[官方显示接口](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/glasses-ui/SKILL.md)。

顶部和底部均为 16 px 字体，底部仅有上方分割线。四个图片区域为 288×34、288×34、288×26、288×26，共 34,560 像素，与原生列表不重叠。PNG 在页面替换前准备，每条栏的两张图共享一次队列占用并顺序发送，只发送变化的区域；列表滑动不写图片、不重建页面。图片更新不能原子提交，真机仍可能分块补齐。展开文本每部分不超过 900 UTF-8 字节，直接随页面创建发送；部分间通过菜单切换。模拟返回值不能代表眼镜画面或真实 BLE 延迟。

手机预览下方的折叠诊断保留最近 60 个 SDK 手势元数据，记录事件类型、容器/行序号、当前页面和选择前后位置。只存内存，关闭页面即丢弃；无消息、标题、key 或录音，不发送到后端。原生列表若不返回滑动回调，手机预览的高亮不保证跟随眼镜高亮，但眼镜的滚动不依赖此预览。

明确返回 invalid／拒绝 rebuild 时，比较一次去掉图片的相同布局，随后恢复全原生基本视图。比较期间忽略任务手势，保留系统退出；不发送 prompt，不改变监控。传输异常退避。首次 create 成功后使用 rebuild，退出后不再创建页面。

编辑页的空草稿双击直接返回；有文字、已录音或等待转写时打开原生双选项确认，默认 Send & exit，另一个为 Exit only。确认时停止录音并保留草稿，点选后才发送或丢弃；确认页双击返回编辑。会话菜单的应用项依次为 Terminate task、Sessions；系统项由固件插入，SDK 无法固定整个菜单的行号。会话双击调用系统退出确认。

手机默认打开 Sessions，按设备分组；折叠分组不创建行，展开先显示 8 条。Conversation 与 G2 是独立页面；手机隐藏对话时跳过 transcript DOM 重建，G2 继续更新。会话操作使用 FleetClient，Unwatch 不停止任务。重复打开同一 Pi 会话时，以实际活动时间选择上报来源，不按心跳来回切换。眼镜列表排除离线会话，但保留 Watch。

## 监控与持久化边界

既有内部所有权标记用于安全更新监控扩展和自启动项。Windows 启动重试只记录无凭据诊断；检查模式等待实际安装版本完成并返回结果。更新任务记录唯一任务 ID、worker/installer PID 和心跳，后端重启后恢复锁；确认进程已退出的失败任务可重试。

监控设置和完成日志写入失败时保留待提交数据并重试；完成事件持久化后才对推送或轮询可见。旧原生终端快照逐批清理，先处理最终完成事件，再验证进程已退出且快照未变化；CLI 历史和活跃终端不参与清理。NotificationRelay 保存出站队列，中心将入站游标与事件原子提交后才确认；专用 relay key 只允许通知接口。自 1.1.0 起，Linux CLI 仅提供连接、会话管理、Watch 和设置；发送 prompt 和取消任务只保留在受支持的手机／G2 页面与原生终端。
