# dsh-opencode-go-usage

DSH 插件：输入框那一行（模型选择器旁）一个 `GO <月度最高占用>%` 胶囊，点开显示各账号的 5 小时 / 周 / 月额度占用与重置时间，30 秒刷新一次。

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
   "error":null}]}
```

- 配置（Schemastery，`Config`）：`refs`（要采样的凭据引用，默认 `OPENCODE_API_KEY_1..4`）、`path`、`endpoint`、`cacheMs`（默认 30000）、`timeoutMs`（默认 15000）。
- 单个账号失败只体现在该行的 `error` 上，不会让整块面板空白；缺凭据是 `missing credential`。

## 浏览器侧

- 只依赖客户端服务 `slots`，注册到 `conversation.input.right`（`order: 40`）；面板向上弹出（`bottom: calc(100% + 6px)`）并限高滚动。
- 不放会话头部的原因见根 README「为什么不在会话头部显示」：Windows 标题栏覆盖层会吞掉顶部 36 DIP 的点击。
- 样式走 DSH 的主题变量（`--dsw-specific-menu`、`--dsw-alias-label-*`、`--dsw-alias-state-warn-*` 等），自动跟随浅色/深色主题；≥80% 的窗口标黄。
- 点击目标做了三处加固：胶囊本身 28px 高并加大内边距、`z-index:2` 抬到同级之上、`::after` 上下各外扩 4px 命中区，同时 `-webkit-app-region:no-drag` 让它在 Electron 里不被拖拽区吞掉点击。