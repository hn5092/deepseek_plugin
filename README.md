# deepseek_plugin

DeepSeek Harness（DSH）插件集合。

| 目录 | 说明 |
| --- | --- |
| `dsh-opencode-go-usage/` | 在 DSH Web 客户端显示 OpenCode Go 各账号额度占用（5 小时 / 周 / 月）的插件 |
| `scripts/Install-DshPlugin.ps1` | 通用安装/卸载脚本：把插件装进 DSH profile |
| `scripts/usage-cli.ps1` | 纯命令行查用量，不装插件也能用 |

## 给别人的一页说明（可直接转发）

前提：对方已装 **DSH Desktop**（或 DSH CLI），并在自己的 DSH 凭据里配好 OpenCode Go 的 API key。

```powershell
git clone https://github.com/hn5092/deepseek_plugin.git
cd deepseek_plugin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1
```

装完在 DSH 窗口按 `Ctrl+R` 刷新页面（**不要**按 `Ctrl+Shift+R`，那是重启 harness）。输入框那一行、模型选择器旁边会出现 `GO <月度最高占用>%` 的胶囊，点开就是各账号 5 小时 / 周 / 月占用与重置时间。

- 他们自己的 key 引用名不是 `OPENCODE_API_KEY_1..4` 时，用 `-Ref` 指定（一条 ref = 一个账号行）：
  `powershell -File scripts\Install-DshPlugin.ps1 -Ref MY_KEY_A,MY_KEY_B`
- CLI harness：加 `-DshHome "$env:USERPROFILE\.dsh"`
- 某条 ref 没配 key 时，那一行显示 `missing credential`（不会静默用别人的 key）
- 卸载（同时清掉 profile patch 里那一行）：
  `powershell -File scripts\Install-DshPlugin.ps1 -Uninstall`
- 只想要命令行、不装 UI：`powershell -File scripts\usage-cli.ps1`
- 安装器只需要 PowerShell；找不到 node 时会跳过 YAML 校验并保留备份，不影响安装

## 安装 dsh-opencode-go-usage

前置：已装 DSH Desktop（或 DSH CLI），并且已有可用的 OpenCode Go API key。

```powershell
git clone https://github.com/hn5092/deepseek_plugin.git
cd deepseek_plugin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1
```

装完**刷新 DSH 窗口**（`Ctrl+R`；或直接重启 App）。输入框那一行（模型选择器旁）会出现一个 `GO <月度最高占用>%` 的胶囊，点开是各账号的 5 小时 / 周 / 月占用和重置时间；面板向上弹出。

- 桌面 harness 默认家目录是 `%APPDATA%\dsh-desktop\harness`；CLI harness 用 `-DshHome "$env:USERPROFILE\.dsh"`。
- 账号行来自插件配置里的 `refs`（默认 `OPENCODE_API_KEY_1..4`），可以这样指定：

```powershell
powershell -File scripts\Install-DshPlugin.ps1 -Ref OPENCODE_API_KEY_1,OPENCODE_API_KEY_2
```

- 卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -Uninstall
```

## 命令行用法（不需要 UI）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\usage-cli.ps1
```

它会读取 DSH 凭据文件里所有 `OPENCODE*` 引用，逐个查用量并打印表格（只显示引用名和 key 尾号）。

## 数据来源与口径

- 端点：`GET https://opencode.ai/zen/go/v1/usage`，用该账号的 API key 鉴权。
- 官方 Go 文档的额度口径：按月美元额度折算，**5 小时 = 月额度 20%、周 = 50%、月 = 100%**；接口回的是各窗口占用百分比和重置时间。
- 端点未在公开文档中列出，属于可用但无兼容承诺；返回 404 即失效，改用 OpenCode console 的 usage history。

## 为什么不在会话头部显示

Windows 上 DSH Desktop 使用 `titleBarStyle: hidden` + `titleBarOverlay`，窗口顶部 36 DIP 是标题栏区域，**该带内的点击不会进入网页**。会话头部正好落在这条带里，胶囊放那里只有露在带外的边缘可点。因此插件注册到输入框行（`conversation.input.right`），并用真实鼠标事件验证过可点、面板完整可见。

## 安全

- 插件只在宿主进程内解析 key，浏览器侧拿到的是 `GET /opencode-go-usage` 的 JSON，**只含引用名和 key 尾号**。
- 该路由由 DSH Web 服务器提供，绑定在本机回环地址（如 `127.0.0.1`），不对外监听。
- 密钥本身仍然存在 DSH 自己的凭据存储里，本仓库不保存任何 key。

## 已知限制

- 只统计经过 DSH 的请求；同一个 key 在别处（Codex CLI、其它工具）的消耗不在这份 UI 里。
- 接口不返回逐模型明细；要知道"哪个模型吃掉的"，看 OpenCode console。