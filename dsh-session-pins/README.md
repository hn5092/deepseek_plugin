# dsh-session-pins

DSH 插件：在左侧栏「工作区」上方加一个**置顶区域**，把常用会话固定在最上面（类似 Codex 的 Pinned）。
点击置顶项直接打开会话；悬停出现「取消置顶」；「＋」打开会话选择器（搜索 + 最近会话）。
置顶状态存在宿主侧，重启 App、清浏览器缓存都还在。

## 结构

```
package.json          # dsh.client 声明（platform=web，依赖侧栏与会话控制器的客户端半）
lib/index.js          # 宿主：GET/POST /session-pins，落盘持久化
lib/client.js         # 浏览器：注入侧栏 DOM 锚点 + 置顶区 UI
```

## 安装

```bash
# macOS / Linux
scripts/Install-DshPlugin.sh --plugin-dir dsh-session-pins

# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -PluginDir dsh-session-pins
```

装完刷新 DSH 窗口（macOS `Cmd+R`，Windows `Ctrl+R`）。插件条目会热加载，不需要重启 harness。

## 配置（Schemastery，`Config`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `path` | `/session-pins` | 宿主路由；改它也要同步改 `lib/client.js` 里的 `ROUTE` |
| `pinsPath` | 空 | 置顶文件；空则用按平台的用户状态目录（Windows `%LOCALAPPDATA%`、macOS `~/Library/Application Support`、其它 `$XDG_STATE_HOME` 或 `~/.local/state`）下的 `session-pins/pins.json` |
| `maxPins` | 50 | 最多置顶多少条 |
| `maxTitleLength` | 200 | 标题保存长度上限 |

## 接口

- `GET /session-pins` → `{"pins":[{"sessionId","title","workspaceId","pinnedAt"}],"store":"<文件路径>","maxPins":50}`
- `POST /session-pins` → `{"action":"pin","sessionId","title","workspaceId"}` 或 `{"action":"unpin","sessionId"}`
- 写盘是「临时文件 + rename」原子替换，写后回读校验；失败则回退到上一次的内存状态并返回 500（不会半应用）。
- 只接受同源请求（带 `Origin` 时必须与 `Host` 一致），body 上限 64 KiB。

## 为什么用 DOM 锚点，而不是 slot

DSH 的 slot 体系**不支持「在已有区域里再插一个区域」**，这是读实现得到的结论：

- 侧栏只有 5 个 slot（`sidebar.brand.mark/name`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.footer.action`），
  「工作区 + 会话列表」整块 = `sidebar.workspaces`，声明为 **`single`**（`@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`）。
- `single` 只渲染一个 entry；slots 服务对同 priority 的第二次注册直接抛错，不同 priority 是**低者渲染**
  （`@deepseek-ai/dsh-client-ui-renderer/lib/client.js` 与 shell 内的 slots 实现），`chain` 也只是选举一个胜出者，没有 `next()` 组合。
- 工作区插件对外只暴露 `sidebar.workspaces.directoryFlow`，会话行/悬停操作/右键菜单/拖拽排序都在 `WorkspaceBrowser` 内部，没有行级 slot。
- 宿主侧也没有内建 pin 能力。

所以要保持原列表不变、又在它上方加常驻区域，只能挂在渲染器输出的稳定锚点上：
每个 slot 都会被包一层 `<div data-slot="…">`，本插件锚定 `[data-slot="sidebar.workspaces"]`，
不依赖任何哈希类名；侧栏折叠（宽度小于 120px）时整块不渲染；锚点一直不出现时只告警、不影响原侧栏。

## 已知限制

- 锚点与注入位置依赖 DSH 渲染 `data-slot` 属性这一约定；DSH 大版本改动该约定时，本区域会退化为「不渲染」。
- 置顶后原会话仍留在工作区列表里（本插件不隐藏原条目）。
- 置顶项若被删除/归档，会以删除线显示并在选择器里消失，但不会自动移除；点「×」即可清理。
- 会话标题在置顶时快照进文件；列表里存在同 id 会话时以实时标题为准。
