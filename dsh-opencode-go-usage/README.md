# dsh-opencode-go-usage

DSH 插件：输入框那一行（模型选择器旁）一个胶囊，**跟随当前会话选中的 provider 账号**显示它的周/月占用（例如选中模型选择器里的 `2` 就显示 `GO 2 · 周 34% · 月 17%`）；点开是全部账号的表（`▸` 标出在用账号），30 秒刷新一次。

面板同时显示 **OpenCode Go** 和 **CommandCode** 两个来源，同一张表、各自用各自的单位：

| 来源 | 5 小时 / 周 / 月 | 额外列 |
| --- | --- | --- |
| OpenCode Go | 百分比（`46%`） | — |
| CommandCode | 美元金额（`$5.15 / $70.00`） | Tokens 入→出 · 请求数 |

CommandCode 行的账号名会带上套餐短名（如 `COMMANDCODE_API_KEY (goat)`），选中它时胶囊显示 `CMD` 前缀。

## 结构

```
package.json          # dsh.client 声明（platform=web，依赖会话 UI 模块）
lib/index.js          # 宿主：注册 GET /opencode-go-usage，按 refs 解析凭据并读用量
lib/client.js         # 浏览器：往 conversation.input.right 注册胶囊+表格
```

## 宿主侧

- 服务依赖：`webServer`、`credentials`。
- 路由：`GET <path>`（默认 `/opencode-go-usage`），返回

```json
{"sampledAt":"2026-09-13T09:20:00.000Z",
 "accounts":[{"account":"OPENCODE_API_KEY_1","key":"****12Mt",
   "rolling":{"percent":15,"status":"ok","resetsAt":"2026-09-13T06:07:41Z"},
   "weekly":{"percent":91,"status":"ok","resetsAt":"2026-09-14T00:00:00Z"},
   "monthly":{"percent":45,"status":"ok","resetsAt":"2026-10-11T13:57:52Z"},
   "error":null},
  {"account":"COMMANDCODE_API_KEY","route":"commandcode","source":"commandcode",
   "key":"****3U81","planId":"individual-goat",
   "rolling":{"percent":36.8,"status":"ok","resetsAt":"2026-09-17T12:15:14Z","used":5.15,"cap":14},
   "weekly":{"percent":14.7,"status":"ok","resetsAt":"2026-09-24T07:15:14Z","used":5.15,"cap":35},
   "monthly":{"percent":7.4,"status":"ok","resetsAt":"2026-09-17T07:14:28Z","used":5.15,"cap":70,"remaining":64.85},
   "tokensIn":76203851,"tokensOut":449781,"requests":495,"spend":5.07,
   "error":null}]}
```

- 采样：宿主进程内按 `sampleEveryMs`（默认 1800000 = 30 分钟，0 关闭）采样，加载时先立刻采一次；`historyPath`（默认取按平台的用户状态目录：Windows `%LOCALAPPDATA%`、macOS `~/Library/Application Support`、其它 `$XDG_STATE_HOME` 或 `~/.local/state`，落到 `opencode-go-usage/history.jsonl`，超 2 MiB 轮转）、`historyMax`（默认 96 条）。接口返回最近 24 条供面板算「Δ周/Δ月」。
- 配置（Schemastery，`Config`）：`refs`（要采样的凭据引用，默认 `OPENCODE_API_KEY_1..4`）、`routes`（与 `refs` 对齐的路由名，例如 `opencode-go-1`；省略则按 `routePrefix` 推导）、`routePrefix`（默认 `opencode-go`，置空则不推导）、`path`、`endpoint`、`cacheMs`（默认 30000）、`timeoutMs`（默认 15000）。
- CommandCode 配置：`commandcodeRefs`（显式列出的引用）、`commandcodeRefPrefix`（默认 `COMMANDCODE_API_KEY`，会同时发现 `<prefix>` 与 `<prefix>_<n>`）、`commandcodeRefMax`（默认 4）、`commandcodeBaseUrl`（默认 `https://api.commandcode.ai`）。**默认无需配置**：只要凭据存储里有 `COMMANDCODE_API_KEY` 就会自动出现一行。

### CommandCode 数据来源

三个端点拼出来，都带 `Authorization: Bearer <key>`：

| 端点 | 取什么 |
| --- | --- |
| `GET /alpha/billing/credits` | `windowLimits.fiveHour/weekly`（used/cap/resetAt）+ 剩余月额度 `credits.monthlyCredits` |
| `GET /alpha/billing/subscriptions` | `data.planId`（如 `individual-goat`）与 `currentPeriodStart` |
| `GET /alpha/usage/summary?since=<periodStart>` | `totalTokensIn/Out`、`totalCount`、`totalCredits` |

- **月额度**：上游只给「剩余」，所以月用量 = 套餐总额度 − 剩余；套餐额度按 CLI 自带的表映射（`individual-goat` → $70）。拿不到 `planId` 时降级用剩余值作分母。
- 注意 `api.commandcode.ai` 才是 API host，`commandcode.ai` 是网页，两者端点不通用。
- 单个账号失败只体现在该行 `error`，不会让整块面板空白。
- 账号列表 = 配置里的 `refs`（没 key 也列出，显示 `missing credential`）+ 自动发现的 `autoRefPrefix<n>`（默认 `OPENCODE_API_KEY_1..8`，只收能解析出 key 的），所以往凭据里加一条 key 就会多一行，不必改配置。
- 单个账号失败只体现在该行的 `error` 上，不会让整块面板空白；缺凭据是 `missing credential`。

## 浏览器侧

- 胶囊读会话投影 `modelSelection.lastUsed.provider`（插槽传来 `sessionId`/`useSessions`）来挑选账号；宿主没给 `route` 时按引用名尾号推导，匹配不到就回退显示全部账号最高值。（`order: 40`）；面板向上弹出（`bottom: calc(100% + 6px)`）并限高滚动。
- 不放会话头部的原因见根 README「为什么不在会话头部显示」：Windows 标题栏覆盖层会吞掉顶部 36 DIP 的点击。
- 样式走 DSH 的主题变量（`--dsw-specific-menu`、`--dsw-alias-label-*`、`--dsw-alias-state-warn-*` 等），自动跟随浅色/深色主题；≥80% 的窗口标黄。
- 点击目标做了三处加固：胶囊本身 28px 高并加大内边距、`z-index:2` 抬到同级之上、`::after` 上下各外扩 4px 命中区，同时 `-webkit-app-region:no-drag` 让它在 Electron 里不被拖拽区吞掉点击。