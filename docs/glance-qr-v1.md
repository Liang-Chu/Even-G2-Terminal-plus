# Even-Pilot / Glance 共用连接二维码（v1）

二维码内容是一条 URL，不是 JSON。桌面 **Connect phone** 的 **Connect your phone** 弹窗和 Linux 的 `even-pilot pair` 使用同一格式、同一个后端 connection key。Glance 可直接扫码；Even Hub 目前仍手工填写 URL/key。

Linux / SSH：运行 `~/.local/bin/even-pilot pair`，终端会打印 Bridge URL、connection key、完整 Glance URL 和二维码，优先使用 Tailscale 地址。用 Glance 的扫码入口扫描，再保存注册。二维码和 key 属于当前执行命令的电脑；集中转发时应在中心服务器运行这条命令。

```text
http://192.168.1.25:4317/#pilot-pair=1&pilot-token=<URL编码后的后端连接key>
```

`192.168.1.25:4317` 仅是示例地址。地址可能随部署变化，扫描端必须读取 URL 中的 scheme、host、port，不要写死这个 IP。二维码由已登录桌面向 `GET /api/pairing` 请求生成，使用当前后端 `controlToken`，不生成第二个 key，也不更改现有凭据。

## Glance 扫描后的字段

| 字段 | 取值 |
| --- | --- |
| Name / watcher | `Even-Pilot`（用户可修改；同设备多 watcher 应使用不同名称） |
| Delivery | `PUSH` |
| Registration URL | URL 的 origin + `/api/glance`，例如 `http://192.168.1.25:4317/api/glance` |
| Credential | fragment 参数 `pilot-token` 解码一次后的原始值；不要加 `Bearer ` 前缀 |
| max_length | 建议 `80` |
| title_max_length | 建议 `32` |
| expires_after_seconds | 测试建议 `30`，保留用户自行设置的值 |

沿用 Glance 已实现的 `register_push`、FID 和 Firebase 发送协议。这个改动仅负责填写连接信息，不改变注册请求。HTTP 请求仍使用 `Authorization: Bearer <Credential>`。

## 解析要求

1. 用 URL 解析器读取 scheme、host、port 与 **fragment**（`#` 后面的内容）；不是 query（`?`）。只接受 HTTP/HTTPS、非空 host、无 username/password、路径为 `/`（空路径等同 `/`）、无 query。
2. 按 `URLSearchParams` / application/x-www-form-urlencoded 规则解析 fragment，每个值只解码一次。`pilot-pair` 必须恰好出现一次且等于 `1`；`pilot-token` 必须恰好出现一次。
3. key 长度为 24–512 个 UTF-16 单位，拒绝 CR/LF。不 trim、不二次 URL decode。未知版本或重复参数应报错，不能覆盖成最后一个值。
4. Registration URL 使用解析后的 origin 拼接 `/api/glance`，移除整个 fragment。不要把二维码原文当成注册 URL，不要把 key 放入 URL query。
5. 扫码填表后走 Glance 现有的保存和注册流程。二维码中不包含 FID、订阅 ID 或 Firebase 私钥；这些仍由各端现有流程提供。

用于实现的参考逻辑：

```js
const u = new URL(scannedText);
if (!['http:', 'https:'].includes(u.protocol) || !u.hostname ||
    u.username || u.password || u.pathname !== '/' || u.search) {
  throw new Error('Invalid connection URL');
}
const p = new URLSearchParams(u.hash.slice(1));
if (p.getAll('pilot-pair').length !== 1 || p.get('pilot-pair') !== '1' ||
    p.getAll('pilot-token').length !== 1) {
  throw new Error('Unsupported connection QR');
}
const credential = p.get('pilot-token');
if (credential.length < 24 || credential.length > 512 || /[\r\n]/.test(credential)) {
  throw new Error('Invalid connection key');
}
const registrationUrl = new URL('/api/glance', u.origin).href;
```

## 不含真实凭据的测试向量

```text
http://192.168.1.25:4317/#pilot-pair=1&pilot-token=sample-key-12345678901234567890%2B%25
```

应解析为：

```json
{
  "registrationUrl": "http://192.168.1.25:4317/api/glance",
  "credential": "sample-key-12345678901234567890+%",
  "delivery": "PUSH"
}
```

桌面响应还包含 `version: 1`、`url`（二维码原文）、`registrationUrl` 和 `image`（PNG data URL）。此 API 仅连接 key 可访问。原有 notification-only credential 仍有效，但不能获取二维码或操作 Pi。共用码按用户要求使用可操作 Pi 的连接 key，应像该 key 一样私密保存，不写日志或分析事件。
