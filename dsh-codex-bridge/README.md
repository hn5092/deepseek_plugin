# dsh-codex-bridge

DSH 插件：让**外部程序**（Codex、脚本、CI）把一条消息投进任意 DSH 会话，效果**和你在输入框里按 Enter 完全一样** —— 包括忙碌时插队。

> **本文只描述最初的单向能力（往会话里投递）。**
> 插件现在**还支持反向**：DS 会话用 `ask_codex` 工具向控制方提问并等待答复、控制方跨多个绑定的
> `wait-any` 信号、以及可恢复的**文件收件箱**。反向能力的**权威接口、状态语义、验收与限制**见
> [INTERFACE.md](INTERFACE.md)；两者在**同一插件、同一状态 owner**上，未拆成第二套服务。

## 它做什么

宿主半开一个 HTTP 路由：

| 路由 | 用途 |
| --- | --- |
| `POST <base>/send` | 投递一条消息：`{ "sessionId": "...", "text": "..." }` |
| `GET <base>/sessions` | 列出当前 shell 能到达的会话 id（省得调用方猜） |
| `GET <base>/health` | 存活与当前 `busyMode` |

`base` 默认 `/codex-bridge`。

## 为什么"和你发的一样"

投递**复用 shell 自己的受理入口** `sessionController.prompt`，而不是另造一条写入路径：

- 消息由 `createUserMessage` 构造，与你手打的完全同构；
- 投递模式按 composer 的**同一条规则**决定 —— 空闲 → `queue`（排队），忙碌 → `busyMode`（默认 `steer`，即插队打断）；
- 忙闲判定读 Agent 自己导出的 `status`（`"idle"` / `"running"`），不复用其它字段自行推导。

对照你的设置：`cordis.patch.yml` 里 `ui-conversation.busyEnter` 配的是 `steer`。把本插件的 `busyMode` 设成同一个值，桥接消息的行为就与手打一致。

实测（真实 harness，连续两次调用同一个会话）：

```json
{"mode":"queue","agentKnown":false,"wasRunning":false,"accepted":true}   // 冷会话 → 排队
{"mode":"steer","agentKnown":true,"wasRunning":true,"accepted":true}     // 运行中 → 插队
```

## 安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -PluginDir dsh-codex-bridge -DshHome "$env:USERPROFILE\.dsh"
```

**宿主半是 Node ESM，装完必须重启 harness 才生效**（浏览器半可以热重载，这个插件没有浏览器半）。
DSH Desktop：关闭并重开 App。CLI：重启 `dsh` 进程。

## 用法（Codex 侧）

```bash
# 先看有哪些会话可以发
curl -s http://127.0.0.1:43132/codex-bridge/sessions

# 投一条消息
curl -s -X POST http://127.0.0.1:43132/codex-bridge/send \
  -H "content-type: application/json" \
  -d '{"sessionId":"session-xxxxxxxx-....","text":"请把这个函数改成尾递归"}'
```

Windows PowerShell：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:43132/codex-bridge/send `
  -ContentType 'application/json' `
  -Body (@{ sessionId='session-xxxxxxxx-....'; text='请把这个函数改成尾递归' } | ConvertTo-Json)
```

返回：

```json
{ "ok": true, "sessionId": "...", "requestId": "codex-bridge-...", "mode": "steer",
  "agentKnown": true, "wasRunning": true, "accepted": true }
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `path` | `/codex-bridge` | 路由前缀 |
| `busyMode` | `steer` | 忙碌时的投递模式；与 `ui-conversation.busyEnter` 保持一致 |
| `sourceLabel` | `codex-bridge` | 来源标记 |
| `requireKnownSession` | `true` | 拒绝投递到当前 shell 未知的会话 id（防手抖打错 id） |

## 安全边界

- **只接受回环调用**：非 `127.0.0.1` / `::1` 直接 403。这条路由**没有凭据**，所以不靠它做认证，靠网络位置。
- 仍然保留官方 `sameOrigin` 守卫。
- 只接受**文本**（上限 100k 字符）。不支持图片、附件、改模型、执行命令。
- 不落任何业务状态：说出去的话只存在于会话记录里，插件不自建第二份。
- 单次投递有 30 秒上限，避免会话卡住时把调用方的 curl 挂死。

## 一个必须知道的限制

**同一个会话不能被两个 harness 进程同时写。** 若目标会话正被另一个实例持有写句柄，投递会以
`session "<id>" is already owned by an active write handle` 失败 —— 这是 shell 的数据保护，不是 bug。
让 Codex 投给**当前正在运行的那个 harness 所服务的会话**即可。

## 结构

```
package.json     # 主入口 lib/index.js（无 dsh.client，纯宿主半）
lib/index.js     # 宿主：注册前缀路由，复用 sessionController.prompt 投递
```
