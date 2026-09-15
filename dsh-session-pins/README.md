# dsh-session-pins

DSH 插件：把常用会话置顶（类似 Codex 的 Pinned）。置顶状态存在宿主侧，重启 App、清浏览器缓存都还在。

三个入口：

| 入口 | 位置 | 接缝 |
| --- | --- | --- |
| 置顶区 | 左侧栏「工作区」上方：点击打开会话、悬停「×」取消、点标题旁的图钉项 | DOM 锚点 `[data-slot="sidebar.workspaces"]` |
| 行菜单项 | 会话行 `···` 菜单里的「置顶 / 取消置顶」 | 包装共享 `Menu` 原语（DSH 没有行菜单 slot） |
| 头部按钮 | 会话头部工具栏的图钉（当前会话已置顶时高亮） | 官方 slot `conversation.session.header.actions` |

## 结构

```
package.json          # dsh.client 声明（platform=web，依赖侧栏/会话/会话控制器/原语的客户端半）
lib/index.js          # 宿主：GET/POST /session-pins，落盘持久化
lib/client.js         # 浏览器：置顶区 + 行菜单项 + 头部按钮
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

## 会话行菜单项怎么加进去的

`···` 菜单同样没有扩展点，而且**不能靠包装模块**：工作区插件把固定的 `items` 数组交给共享原语
`primitives.Menu` 渲染，但那个模块是加载器的**平台种子模块**，在 shell 里就是
`const Fp = Object.freeze(Object.defineProperty({…, Menu: …}, Symbol.toStringTag, …))` ——
冻结对象上给 `Menu` 赋值会静默失败（非严格模式），所以第一版「包装导出」的做法永远不生效。

最终做法是**往弹层里注入一项**。弹层由原语 `createPortal` 挂到 `<body>`，结构是
`div[role="menu"] > div[role="presentation"] > div(每项) > button[role="menuitem"]`（内含 `itemIcon` / `itemLabel` 两个 span）：

- 用 `MutationObserver` 监听 `<body>` 新增的 `[role="menu"]`；
- 命中会话菜单的判断：**优先按位置**（弹层顶部与 `[role="treeitem"]` 行重叠/相邻，配合最后一次按下指针的行），
  位置判不出来时再退回文案（`分叉会话` / `归档会话` / 对应英文）；
- 克隆**最后一项**（连同原语的 class 与 hover 行为），改文案与图标，挂自己的 click（capture，`stopPropagation`），
  插到它后面；克隆节点没有原语的事件处理器，所以不会误触原来的动作；
- 会话 id 的取得顺序：该行 → 沿 React props 链找带 `id` 的 `node`/`session`；失败时**不猜**，
  只在置顶区提示「没能识别这一行的会话」；
- 关闭弹层用原语自己的方式：向 document 派发 `Escape`（原语监听 `keydown` 里的 Escape）；
- 弹层每次打开都是新节点，注入项随之消失，不需要清理。

仍然依赖三条非官方前提：弹层 `role="menu"` / 行 `role="treeitem"` / React props 可读。DSH 升级后若失效，
表现为菜单项不出现或出现上述提示，**头部按钮（官方 slot）不受影响**——这是保留它的原因。

`conversation.session.header.actions` 是 `list` + `scope: "session"` 的官方 slot，`sessionId` 由框架传入
（`dsh-client-ui-jobs` 同样用法），所以那条路径零 hack。

## 已知限制

- 锚点与注入位置依赖 DSH 渲染 `data-slot` 属性这一约定；DSH 大版本改动该约定时，本区域会退化为「不渲染」。
- 行菜单项依赖上面三条非官方前提（见上）；失效时用头部按钮或置顶区的「＋」。
- 置顶后原会话仍留在工作区列表里（本插件不隐藏原条目）。
- 置顶项若被删除/归档，会以删除线显示并在选择器里消失，但不会自动移除；点「×」即可清理。
- 会话标题在置顶时快照进文件；列表里存在同 id 会话时以实时标题为准。
- 改 `package.json` 的 `dsh.client.inject` 只在 harness 重新启动后反映到 boot 模块图（实测：改 patch 内容不会刷新该描述符）。
  不影响功能——客户端 `require` 的静态模块（如 `primitives`）按需解析，`dsh-client-ui-agent-preset` 就是没声明也能用。
