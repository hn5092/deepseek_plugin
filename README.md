# deepseek_plugin

DeepSeek Harness（DSH）插件集合。

| 目录 | 说明 |
| --- | --- |
| `dsh-opencode-go-usage/` | 在 DSH Web 客户端显示 OpenCode Go 各账号额度占用（5 小时 / 周 / 月）的插件 |
| `dsh-session-pins/` | 置顶常用会话（类似 Codex 的 Pinned）：左侧栏置顶区 + 会话行 `···` 菜单的「置顶」+ 会话头部图钉按钮 |
| `scripts/Install-DshPlugin.ps1` | 通用安装/卸载脚本：把插件装进 DSH profile（`-PluginDir` 指定任意插件目录） |
| `scripts/Install-DshPlugin.sh` | 同上，macOS / Linux 用的 POSIX 版本（`--plugin-dir`） |
| `scripts/usage-cli.ps1` | 纯命令行查用量，不装插件也能用 |
| `provider/deepseek/` | DeepSeek 官方 provider 配置（模型目录含视觉模态），用 `Install-DeepSeek.ps1` 一键装 |
| `scripts/Install-DeepSeek.ps1` | 一键装/卸 DeepSeek 配置（桌面 settings 模式 / CLI profile 模式） |
| `provider/commandcode/` | CommandCode provider 路由模板（DeepSeek V4.1 Flash / V4 Flash / V4 Pro，带 ZDR 开关） |
| `scripts/Install-CommandCode.sh` | 一键装/卸 CommandCode 路由，与 OpenCode Go 路由共存（macOS / Linux） |

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
- 5 路 OpenCode Go 路由（每路独立 key、独立 session header）被 App 写回后，用 `powershell -File scripts\Install-OpenCodeGo.ps1` 一条命令重放（详见「OpenCode Go 五路路由」）
- 也要用 CommandCode 的 DeepSeek V4.1 Flash：`scripts/Install-CommandCode.sh`（需 GOAT 或以上套餐，详见「CommandCode 路由」）
- 安装器只需要 PowerShell；找不到 node 时会跳过 YAML 校验并保留备份，不影响安装
- **macOS / Linux 不需要 PowerShell**：同一套安装器有 `.sh` 版本，语义与 `.ps1` 一致（详见「macOS / Linux 安装」）

## 安装 dsh-opencode-go-usage

前置：已装 DSH Desktop（或 DSH CLI），并且已有可用的 OpenCode Go API key。

```powershell
git clone https://github.com/hn5092/deepseek_plugin.git
cd deepseek_plugin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1
```

装完**刷新 DSH 窗口**（`Ctrl+R`；或直接重启 App）。输入框那一行（模型选择器旁）会出现一个胶囊，**跟随你当前选中的 provider**：模型选择器里的 `1/2/3…` 就是路由 `opencode-go-1/2/3…`，选 2 就显示 2 号账号的周/月占用（点开是全部账号的表，`▸` 标出在用账号）；匹配不到时回退显示全部账号最高值。

- 桌面 harness 默认家目录是 `%APPDATA%\dsh-desktop\harness`；CLI harness 用 `-DshHome "$env:USERPROFILE\.dsh"`。
- profile 名也是按存在的那个挑：Windows 桌面是 `web`，macOS 桌面是 `desktop`，只有一个 profile 时用它；要强制指定用 `-ProfileName`。
- 账号行来自插件配置里的 `refs`（默认 `OPENCODE_API_KEY_1..4`），可以这样指定：

```powershell
powershell -File scripts\Install-DshPlugin.ps1 -Ref OPENCODE_API_KEY_1,OPENCODE_API_KEY_2
```

- 卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -Uninstall
```

## macOS / Linux 安装

macOS 和 Linux 上 DSH 的 home 是 `$HOME/.dsh`（Desktop 与 CLI 共用），macOS 桌面的 profile 叫
`desktop`。`scripts/*.sh` 与 `scripts/*.ps1` 是同一套语义，并且互相认得对方写的受管块，可以混用。

```bash
git clone https://github.com/hn5092/deepseek_plugin.git
cd deepseek_plugin

scripts/Install-DshPlugin.sh                       # 装插件（profile 自动挑 web → desktop → 唯一的一个）
scripts/Install-DshPlugin.sh --ref KEY_A,KEY_B     # 指定凭据引用名，一条 ref = 一个账号行
scripts/Install-DshPlugin.sh --uninstall           # 卸载

scripts/Install-OpenCodeGo.sh                      # 重放五路 OpenCode Go 路由
scripts/Install-OpenCodeGo.sh --client my-mac --dry-run
```

- 所有 `.sh` 都支持 `--dry-run`（只打印差异不落盘）、写前时间戳备份、写后用 harness 自带 YAML 解析器
  校验、失败自动回滚；`--dsh-home` / `--profile` / `--plugin-dir` 可覆盖默认值。
- 装完刷新窗口：macOS 上是 **`Cmd+R`**（`Ctrl+R` 是 Windows）。插件宿主侧新增路由会热加载，浏览器侧
  bundle 会重新组合，一般不需要重启 harness。
- profile 的 `cordis.patch.yml` 若是默认的 `[]` 占位，安装器会把这一行**替换**成受管行再写入：`[]`
  后面直接跟序列项不是合法 YAML，旧写法（追加）会让写后校验失败并回滚。
- 只想看数字：`curl -s 127.0.0.1:3080/opencode-go-usage`（只含引用名和 key 尾号），或
  `pwsh -File scripts/usage-cli.ps1`（`.ps1` 在 macOS 上要装 PowerShell；`usage-cli` 目前尚无 `.sh` 版本）。

## OpenCode Go 五路路由

`provider/opencode-go/` 里是五路并行路由的模板：五条 `opencode-go-1..5`，每条一个 `apiKeyEnv`
凭据引用、一个 `x-opencode-session`，所以同一个订阅的五个 key 可以各自成路、各自被 UI 选中。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-OpenCodeGo.ps1
# 指定 client 标签与五条引用名：
powershell -File scripts\Install-OpenCodeGo.ps1 -Client dsh-desktop-mybox -Ref KEY_A,KEY_B,KEY_C,KEY_D,KEY_E
# 只看会改什么（会列出将被替换掉的 provider id）：
powershell -File scripts\Install-OpenCodeGo.ps1 -DryRun
```

```bash
scripts/Install-OpenCodeGo.sh --client my-mac                 # macOS / Linux
scripts/Install-OpenCodeGo.sh --uninstall
```

- 写的是 `settings.yaml` 的 `llm-pi-ai` 段与 `agent-default-model` 段（后者默认 `opencode-go-2` /
  `deepseek-v4.1-flash` / `reasoningEffort: max`，可用 `-DefaultRoute/-DefaultModel/-ReasoningEffort` 改）。
- `-Client` 替换模板里的 `__CLIENT__`：**重放时保持同一个值**，`x-opencode-session` 才稳定。
- DSH Desktop 改 UI 偏好时会按自己的快照重写 `settings.yaml`，把这一段退回；重跑安装器即恢复，这是设计上的重放路径。
- 原有的**非受管** `llm-pi-ai` 段也会被整体替换（写前备份 `settings.yaml.bak-<时间戳>`，写后用 harness 的 YAML 解析器校验，失败自动回滚）。所以先跑一次 `-DryRun`。
- 每条路由要有自己的 key（同名凭据引用或环境变量）；缺 key 的那一路在使用时报 `MISSING_CREDENTIAL`。

## CommandCode 路由（DeepSeek V4.1 Flash 等）

`provider/commandcode/` 里是一条 CommandCode 路由的模板：`commandcode`，一个 `apiKeyEnv`
凭据引用（默认 `COMMANDCODE_API_KEY`），三个模型 `deepseek/deepseek-v4.1-flash`、
`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro`。

```bash
scripts/Install-CommandCode.sh                    # macOS / Linux
scripts/Install-CommandCode.sh --ref MY_CMD_KEY   # 换凭据引用名
scripts/Install-CommandCode.sh --set-default      # 顺便把 agent-default-model 指过来
scripts/Install-CommandCode.sh --dry-run          # 只看会改什么，不写盘
scripts/Install-CommandCode.sh --uninstall
```

- **和 OpenCode Go 路由共存**：本脚本只动自己 `# >>> dsh-commandcode route` /
  `# <<< dsh-commandcode route` 之间的块，插在现有 `llm-pi-ai.providers` 映射里，不重写整个
  `llm-pi-ai` 段，所以 `Install-OpenCodeGo.sh` 的重放不会互相冲掉。
- 段不存在时会自己创建 `llm-pi-ai:` + `providers:`；块已存在时原地替换，重复运行结果一致（幂等）。
- 写前备份 `settings.yaml.bak-<时间戳>`，写后用 harness 的 YAML 解析器校验，失败自动回滚。
- **脚本从不写 key**：模板里的 `__REF__` 只替换成凭据引用名，key 留在 DSH 凭据存储
  （`~/.dsh/.credentials.yaml` 的 `refs:` 段）或同名环境变量里。
- 设置按请求重新读取，**新增路由无需重启**。

要点（2026-09-17 实测）：

- **套餐必须是 GOAT 或以上**。除 Go 套餐外都有 API 权限；Go 套餐的 key 打
  `/provider/v1/chat/completions` 会返回 `403 upgrade_required`（但 `/provider/v1/models` 仍返回 200，
  别用这个判断）。
- 图片输入按模型分别声明（**模型能力必须声明，声明错了附件会被静默丢掉**）。实测：

  | 模型 | 图片 |
  | --- | --- |
  | `deepseek/deepseek-v4.1-flash` | ✅ |
  | `deepseek/deepseek-v4-flash` | ✅ |
  | `deepseek/deepseek-v4-pro` | ❌ 纯文本（上游回 *I can't read the image*） |

- 模板**默认不带** `x-cmd-zdr`；要零留存加 `--zdr`。**但开 ZDR 会明显更贵**，官方 ZDR 页面写得很明确：
  > *Metered at the default allowance: ZDR requests use your plan's default allowance, even if a model normally has a higher boosted allowance. That means $20 on GOAT … the same credits buy fewer ZDR requests than regular ones.*

  具体到 `deepseek-v4.1-flash`：不开 → 额度 **$60**；开了 → 被压到默认额度 **$20**（**少 3 倍**），
  而且 ZDR 可能路由到更贵的上游，单价也更高。**所以除非确实需要零留存，否则不要开。**
- 开了 ZDR 之后，没有 ZDR 上游的模型会以 HTTP 422 `cmd_zdr_no_providers` 失败，而不是悄悄回退。
- 思考档位上游接受 `low | medium | high | xhigh`，`max` 也接受，**`none` 返回 HTTP 400**，所以模板里没有声明 `none`。

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
- **profile 模式**：建 `profiles/<名字>/`（`package.json` + `cordis.patch.yml` + 空的 `cordis.yml`），`-Surface web|headless` 决定挂哪个 bundle；`dsh --profile <名字>` 直接可用。它同时写 `agent-default-model`（默认 `opencode-go-2` / `deepseek-v4.1-flash` / `reasoningEffort: max`，可用 `-DefaultRoute/-DefaultModel/-ReasoningEffort` 改），所以重放后默认推理等级仍是 max。

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