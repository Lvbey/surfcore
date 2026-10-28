# SurfCore Linux + NapCat 迁移设计（交接给实施 Agent）

> 状态：只读仓库调研后的实施设计；尚未修改代码或部署服务。
> 仓库：Lvbey/surfcore（默认分支 main）。
> 目标：在 Linux 服务器运行 SurfCore + DSH，使用 NapCat 替换 SnowLuma，尽量保留 Windows 支持与已有用户数据。

## 1. 现状与已确认事实

- `package.json` 的 Node 引擎要求为 `>=22.13.0`。
- `src/bridge.js` 直接导入 `SnowLumaWebSocketClient, text` from `@snowluma/sdk`；同时导入 `./snowluma-conn.js` 里的 `discoverSnowLumaConnection`、`persistSnowLumaEndpoint`、`persistToken`。这属于真正的协议耦合点。
- `package.json` 直接依赖 `@snowluma/sdk`、`@snowluma/mcp`，`postinstall` 执行 `scripts/patch-snowluma-sdk.mjs`。
- `scripts/setup-dsh.mjs` 把 MCP server 注册为 `mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe`，并引用 `src/mcp-snowluma-safe.js`、`src/mcp-host-server.js`、`src/mcp-web-search-safe.js`。
- `src/mcp-snowluma-safe.js` 和 `src/mcp-host-server.js` 在 HTTP API 路径上读取 `config.json` 的 `snowluma.httpUrl/accessToken`。前者负责许多 QQ MCP 工具，不能只改 WS 客户端就宣称迁移完成。
- `src/snowluma-conn.js` 会读取 SnowLuma 每账号配置文件里的 token；这是 SnowLuma 专属的自动发现功能，NapCat 路径应改成显式配置 / NapCat config provider，不应直接保留旧的文件结构假设。
- `plugins/surfcore/lib/paths.js` 已有跨平台路径拼接，但有 `USERPROFILE || os.homedir()`。Linux 上应以 `os.homedir()` 为主，并验证显式 `DSH_HOME`、`SURFCORE_ROOT` 环境变量。
- `src/state-acl.mjs` 已对非 Windows 系统使用 `chmod 700/600`，但其调用流程、父目录及创建新文件后的权限仍需审计。其他位置可能仍有 `icacls`、`cmd.exe`、`.bat`、Windows 路径和进程判断。
- `README.md`、`docs/guides/INSTALL.md`、`ROADMAP.md` 都按 Windows 单平台设计。
- 当前架构里 DSH 插件会监督桥接进程，桥接也可通过 `npm start` 手动启动；Linux 方案必须选择单一的主要监督者，避免 systemd 与插件重复启动两个实例。

## 2. 目标架构

```
Linux host
├── DSH (Node/Electron/服务形态：以服务器实际安装方式为准)
│   └── SurfCore bundle：UI、记忆、B站调度、角色、额度
├── SurfCore bridge：node src/bridge.js
│   ├── OneBot adapter (WS inbound + HTTP actions)
│   ├── DSH API/client
│   ├── safe QQ MCP tools
│   └── local console bound to 127.0.0.1
└── NapCat (Docker recommended)
    ├── OneBot v11 WS listener bound to loopback
    ├── OneBot HTTP APIs bound to loopback
    └── persisted account/config/plugin volumes
```

原则：
1. NapCat 是独立的协议端，SurfCore 不下载、打包、扫码或自动控制 QQ 账号。
2. 以标准 OneBot v11 为公共契约，NapCat 特有功能放在 adapter capability layer，不污染业务逻辑。
3. `config.json` 旧的 `snowluma` 字段先保持兼容；增加 `onebot` 配置，并提供只读迁移建议。不要启动时静默重写用户配置。
4. Linux 是新增平台，不删除 Windows 支持；Windows ACL/脚本与 Linux chmod/systemd/路径逻辑分开实现。
5. 记忆、角色、会话、账号配置不得因迁移或部署重新安装而清空。

## 3. 推荐配置模型

首选新结构（最终字段名要在现有 schema / UI 一处定稿）：

```json
{
  "onebot": {
    "adapter": "napcat",
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "wsAccessToken": "从 NapCat 配置得到的 WS token",
    "httpAccessToken": "HTTP token；若同值可显式重复配置",
    "timeoutMs": 15000
  }
}
```

建议支持旧结构 `snowluma.wsUrl/httpUrl/accessToken` 作为 legacy fallback；如果用户同时配置了新旧结构，明确新结构优先并给出诊断提示。由于原实现把 HTTP 与 WS token 共用/自动发现处理得比较复杂，必须确认 NapCat 两侧 token 在当前部署中实际如何配置，不能猜测。

## 4. 阶段性任务

### P0 — 完整盘点，不写代码前完成
- 全仓库搜：`@snowluma/`、`snowluma`、`SnowLuma`、`icacls`、`cmd.exe`、`taskkill`、`USERPROFILE`、`.bat`、`path.win32`、硬编码盘符、`powershell`、`process.platform`、`launcherPath`。
- 分类为：协议 WS、OneBot HTTP、NapCat/SnowLuma 特有 API、SDK message/text 解析、探活/状态、自动发现 token、安装器、Windows ACL、GUI-only（Electron 桌宠）。
- 查明 `text()` 在消息解析的所有用法；需要迁移为统一的 OneBot message segment normalizer，不能只删 import。
- 查明 `mcp-snowluma` 工具名与两套 QQ preset 的关系。为了兼容，不要在首阶段随意改 MCP tool names / preset 引用。
- 读 `docs/ROADMAP.md`、`docs/HANDOFF.md`、`docs/PITFALLS.md` 的顶部与相关 Windows/OneBot 章节，然后把迁移里程碑写入 ROADMAP/HANDOFF。

### P1 — 建立 adapter（首先实现，先不动大面积业务）
- 新增例如 `src/onebot/adapter.js`、`src/onebot/napcat.js` 或等价清晰结构；避免为了迁移而引入不必要的抽象层。
- adapter 公共接口至少涵盖：connect / close / reconnect / connection state；入站事件映射（私聊、群聊、通知、心跳、账号上线/离线）；HTTP action 调用与鉴权；发送文本、回复、图片、语音、表情、戳一戳、转发消息；login info / friend & group list / history；self identity、message id、sender、message segments 的规范化；capability status（不支持能力必须显式标示，不可静默伪造成功）。
- 确认 OneBot 标准协议与 NapCat 的扩展行为；各能力以官方当前文档、NapCat 源码和真机响应为证据。
- 将当前 `SnowLumaWebSocketClient` 换成 adapter 接口。业务层不应引用 SDK 的特殊 class 或特殊 message decoder。
- 保留 OneBot HTTP 的公共调用层，集中 timeout、token、错误翻译、retcode 验证。
- `src/mcp-snowluma-safe.js` 中业务实际是通用 OneBot 工具，可逐步更名为 `mcp-qq-safe.js`，但先确保 preset tool references 与版本兼容；若名称更改，做兼容别名/一次性迁移并加断言。
- `mcp-host-server.js` 改为通用 OneBot 状态探测 MCP；支持显示 adapter 类型，不读 SnowLuma 专属 homeDir。
- 对旧配置读写（token auto-discovery、endpoint persistence、settings UI）改为 adapter provider 抽象。NapCat 初期优先显式 URL/token 配置，而不是假造自动发现。

### P2 — Linux 核心兼容
- 为所有路径使用 `node:path`；禁止跨平台默认使用 win32 路径。
- 使用 `os.homedir()` + `DSH_HOME`，清晰地区分 `SURFCORE_ROOT`（仓库）与 DSH state。
- 安全权限：目录默认 0700、密钥文件 0600；创建/复制/备份时保持权限；对 symlink 和已有目录做审计。Windows 继续使用现有 ACL 逻辑。
- 子进程统一使用 `spawn` 的 argv 数组与 `shell:false`；仅 Windows .cmd 入口经过必要 shim；Linux 不应依赖 `cmd.exe`。
- 避免启动时执行任何平台特有的命令，平台能力探测失败需有清楚提示。
- 不要把 Electron UI/桌宠要求强行带进无图形服务器的核心启动路径。对桌宠标记 unsupported/degraded；QQ/记忆核心仍应正常。
- 检查 bridge supervisor 的启动、停止、PID、锁文件与 zombie 进程行为；对 signal SIGTERM/SIGINT 做正常关闭，退出时释放锁与 WS。
- 控制台只绑定 `127.0.0.1`，不要因为 Linux 容器部署而改为 `0.0.0.0`。
- B站子系统是否能在 Linux 下正常运行需作为独立轨迹评估；不要因 QQ adapter 改造顺手重写 B站逻辑。

### P3 — Linux 部署文件
- 增加 `deploy/linux/compose.yaml.example` 或 `deploy/napcat/compose.yaml.example`（具体路径先查是否已存在）。
- 增加 `deploy/systemd/surfcore-bridge.service.example`，使用专门的非 root 服务用户，配置 EnvironmentFile；服务重启不清理持久化目录。
- 配置检查脚本 `node scripts/check-onebot-status.mjs` 适配新 `onebot` 字段（当前脚本很可能直接读旧字段，需检查）。
- 增加 `docs/guides/INSTALL-LINUX.md`，描述 Node >=22.13、DSH/profile 安装、NapCat 容器部署、扫码由用户本人完成、WS/HTTP token、端口回环绑定、服务启动/停止/日志/备份/恢复。
- 更新 README：清晰写出当前能力状态，Windows 支持不回归；不要把所有平台都写成 fully supported，直到验证完成。
- 版本与更新功能要确认 Linux git 部署可用；不要通过 Windows Release 安装器更新 Linux 服务。

### P4 — 测试 / cutover
- 离线回归至少：`npm run test:audit`、`npm run test:regressions`、`npm run verify:adaptation`；插件侧：`cd plugins/surfcore && npm test`（以当前 package scripts 为准）。
- 新建 OneBot adapter contract tests：模拟 WS 连接、鉴权失败、断线重连、重复事件/消息去重、私聊群聊事件、send_msg 的 retcode 非 0、媒体 URL、unknown event、WS ping/pong。
- 对 HTTP API 测试：超时、非 2xx、retcode 错误、token 不匹配、HTTP 426（URL 配错）。
- 使用测试夹具做 Windows + Linux 两平台路径/权限/进程测试；Linux CI 用 Ubuntu，不执行真实 QQ 操作。
- 真机验证清单：NapCat 登录在线；私聊入站 → DSH 会话 → 回复 outbound；群聊白名单；引用、图片、转发、表情、戳一戳、语音、历史补取；掉线重连；token 重启后仍可用；记忆/角色/token budget 未丢；DSH 和桥接重启顺序正确。
- 切换前备份仓库外所有配置和 state；保留旧 Windows 部署运行至 cutover 验收完成，回滚只需把配置切回旧 OneBot endpoint/启动旧部署。

## 5. NapCat 容器部署注意事项
- 使用 NapCat 官方 Docker 文档/仓库给出的镜像与变量作为起始，不要未经核对复制过时镜像标签。
- 示例原则：NapCat WebUI/OneBot 端口都只绑定 loopback；持久化配置与 QQ 用户目录挂载到明确的数据目录；固定或定期更新镜像版本并记录验证过的版本。
- 先阅读 https://github.com/NapNeko/NapCat-Docker 的当前 README，确认镜像、MODE、端口和卷结构；不要假设 NapCat WebSocket 是 reverse 还是 forward。
- 服务器登录扫码流程只提供操作说明，不编写绕过登录/风控的流程。
- NapCat 单独由 Docker Compose 管理；SurfCore bridge 不负责装/启/停 NapCat。systemd 和插件监督关系须二选一或加明确的 disable-supervisor 配置。

## 6. 验收标准
- 新 Linux 主机能够按文档干净部署，不依赖 Windows 文件、批处理、ACL 或用户交互式桌面。
- NapCat 正常登录；OneBot WS + HTTP 连通，至少基本私聊/群聊收发可靠。
- 所有出站消息仍通过原有白名单、审计与发送闸门；不因 adapter 替换绕开安全策略。
- 旧 Windows 配置仍可读且原平台回归通过；新 onebot 配置不会把 token 写进日志。
- 用户数据完整，备份可恢复；systemd/Docker 重启策略符合单实例约束。
- 迁移文档、回滚步骤、测试结果和未支持能力列表清晰。

## 7. 执行策略
- 不要一次性重写 `src/bridge.js`（当前它是大型单体）；按 adapter 边界小步替换。
- 不要把未验证成功说成完成。每一步记录：现象 → 根因 → 影响 → 修法 → 测试 → 回滚。
- 每个行为改动同时更新 README/INSTALL-LINUX/ROADMAP/HANDOFF 与相关 PITFALLS。
- 未明确部署 OS / CPU 架构之前，部署文件须同时支持 amd64 常见 Linux，并标记 NapCat 官方当前支持的 arm64 情况，不能默认为全部平台均已测。