# deepseek_plugin

DeepSeek Harness（DSH）插件集合。

| 目录 | 说明 |
| --- | --- |
| `dsh-opencode-go-usage/` | 在 DSH Web 客户端显示 OpenCode Go 各账号额度占用（5 小时 / 周 / 月）的插件 |
| `scripts/Install-DshPlugin.ps1` | 通用安装/卸载脚本：把插件装进 DSH profile |
| `scripts/usage-cli.ps1` | 纯命令行查用量，不装插件也能用 |
| `provider/deepseek/` | DeepSeek 官方 provider 配置（模型目录含视觉模态），用 `Install-DeepSeek.ps1` 一键装 |
| `scripts/Install-DeepSeek.ps1` | 一键装/卸 DeepSeek 配置（桌面 settings 模式 / CLI profile 模式） |

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
- 也想用 DeepSeek 官方模型：`powershell -File scripts\Install-DeepSeek.ps1`（详见「DeepSeek 官方 provider 配置」）
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

## DeepSeek 官方 provider 配置（一键安装）

`provider/deepseek/` 里是本机在用的 DeepSeek 配置，两种用法都由一个脚本装好：

```powershell
# 桌面（写进 %APPDATA%\dsh-desktop\harness\settings.yaml 的模型目录）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DeepSeek.ps1

# CLI：建一个可以直接 dsh --profile deepseek 启动的 profile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DeepSeek.ps1 -DshHome "$env:USERPROFILE\.dsh" -Scope profile

# 两个都要（比如桌面 home 里也建一份 profile 用 web 界面跑）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DeepSeek.ps1 -Scope both -Surface web
```

装的是什么：

- **settings 模式**：把 `llm-deepseek` 模型目录（`deepseek-v4-flash` 支持图片输入、`deepseek-v4-pro` 纯文本、`deepseek-v4-flash-vision-exp` 带 `imagePixelBudget`/`imageMaxBytes`）合并进 `settings.yaml`；`apiKeyEnv`/`baseURL` 用插件默认值（`DEEPSEEK_API_KEY` / `https://api.deepseek.com`），所以文件里不长出第二份真源。
- **profile 模式**：建 `profiles/<名字>/`（`package.json` + `cordis.patch.yml` + 空的 `cordis.yml`），`-Surface web|headless` 决定挂哪个 bundle；`dsh --profile <名字>` 直接可用。

安全与可回滚：

- 写前备份（`settings.yaml.bak-<时间戳>`），写后用 harness 自带 YAML 解析器校验，失败自动回滚；
- 已有**非受管**的 `llm-deepseek:` 段时明确拒绝覆盖（本机现状就是这种，脚本会提示先手工合并）；
- 卸载：同一条命令加 `-Uninstall`（同时清掉受管块 / profile 目录）；
- **脚本不写密钥**：`DEEPSEEK_API_KEY` 由你自己写进 DSH 凭据（`<DshHome>/.credentials.yaml` 的 `refs:`）或用同名环境变量。

Codex CLI 用户：`provider/deepseek/codex/deepseek.config.toml` 可直接复制成 `$CODEX_HOME/deepseek.config.toml`，然后 `codex -p deepseek`。

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