# 主实例启用步骤（root 外部执行）

本文件是**给 root 的执行清单**，不含任何密钥值。所有路径按需替换为真实值。

## 前置事实（已在隔离实例实测）

- **首次安装不需要重启主服务。** Harness 会 watch profile 的 `cordis.patch.yml`，文件一变就重新协调
  Loader。实测：同一进程内从「插件不存在（404）」变为「路由 200」。
- **升级「已加载过」的插件必须重启 Harness。** 实测结论（`collab-upgrade` 33/33）：宿主已经 import
  过该模块后，Loader 重载时按名字重新 import，而 **Node 的 ESM 缓存直接返回已加载的旧模块**，
  于是运行中的宿主**继续提供旧 artifact**。此时 patch 层确实重载了（移除该行路由即 404），
  session 也仍在，**只有模块本身不会换**。安装脚本因此返回 `restart-required`（退出码 3），
  **不会**谎称热升级成功，也**不会**把正确的磁盘安装回滚掉。
  ⇒ **主实例当前装的是旧单向桥，升级必须重启一次 Harness。**
- **准确限制**：`--patch <file>` 这类**启动参数**补丁只在启动时读一次，改写它**不会**热加载。
  所以要写 **profile 自己的** `cordis.patch.yml` —— 安装脚本就是这么做的。
- 本机主实例：`127.0.0.1:43132`，PID 应保持 `43136`（本轮未安装、未重启）。

## 一、准备凭据与配置（只放引用，不放值）

1. 在 `<DshHome>/.credentials.yaml` 的 `refs:` 下登记一个控制方令牌引用，例如
   `CODEX_BRIDGE_TOKEN_MAIN: <值>`。也可用环境变量同名注入。
2. 复制 `dsh-codex-bridge/bridge-config.example.yml` 为本地配置（**不要提交**），改三处：
   - `inboxRoot` / `storeRoot` → 你希望的实际运行目录；
   - `bindings` → 真实 `sessionId`、真实 `cwd`、以及上面那个 `tokenRef`；
   - 同一控制方的所有绑定**用同一个 `tokenRef`**。
3. 列出当前会话与其真实目录，确认写入的 `cwd` 与会话实际工作目录一致：

   ```powershell
   # 用 CLI 读绑定（装好后）；装之前可用 dsh-control.mjs 的会话列表能力
   node dsh-codex-bridge\scripts\bridge-cli.mjs bindings --url-file <launch-url-file> `
     --token-ref CODEX_BRIDGE_TOKEN_MAIN --controller codex
   ```

> 一个 controller 可以有**多个 session**（不同目录）；**同目录不会被合并**。
> 两个绑定若声明**同一个 session 为存活 owner**，或会话真实目录与 `cwd` 不符，插件**拒绝激活**。

## 二、安装（精确提交 + 健康门）

```powershell
cd D:\workspace\_tools\deepseek_plugin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CodexBridge.ps1 `
  -Commit <本轮冻结的精确提交> `
  -ControllerConfig <你的本地配置.yml> `
  -HealthUrl <launch-url-file>
```

- `-Commit` 由 root 填入**本轮冻结的精确提交**（安装脚本会用 `git rev-parse` 校验它就是该提交）。
- `<launch-url-file>`：含主实例启动 URL 的日志文件（`-HealthUrl` 会从中读取 `http://127.0.0.1:43132/?token=...`）。
- 脚本行为：从**精确提交**取干净产物（不含测试/日志）；只改本插件自己的块，**其它插件与注释不动**；
  写前备份、写后用 Harness 自带 js-yaml 复核。
- **健康门**：`-HealthUrl` 会**先登录换 cookie**，再要求响应**同时**列出 `codex-collab` 路由与
  `bindings`。**旧单向桥的匿名 200 不算通过**；主实例的 401 也不会被误判成失败。
- **退出码**：`0` 成功；**`3` = 磁盘写入正确、但运行中的宿主仍提供旧 artifact，需要重启 Harness**
  （见上方「前置事实」）；其它非 0 = **首次安装**失败且**已回滚**（patch 与本插件 artifact 都还原）。
- **升级不会回滚**磁盘上正确的安装 —— 回滚会毁掉已经正确的产物，所以只报告需要重启。
- **回滚绑定本插件收据**：`-Rollback` 只移除本插件自己的标记块，并恢复收据记录的那个旧 artifact。
  若该块在安装后被改动过（并发编辑），回滚**明确拒绝**，**不覆盖**别人的修改；没有收据也**拒绝猜测**。
- **`-HealthUrl` 用不上时**：安装后手动确认
  `node dsh-codex-bridge\scripts\bridge-cli.mjs health --url-file <launch-url-file>`
  （CLI 会自动登录；`bindings` 为 0 或没有 `codex-collab` 路由即表示仍是旧桥）。

## 三、验证

```powershell
# 1) 存活 + 路由
node dsh-codex-bridge\scripts\bridge-cli.mjs health --url-file <launch-url-file>

# 2) 绑定读到你的 sessions
node dsh-codex-bridge\scripts\bridge-cli.mjs bindings --url-file <launch-url-file> `
  --token-ref <你的tokenRef> --controller codex

# 3) 跨会话等待（20 分钟总截止；无事件返回码 3 且无输出，不调用模型）
node dsh-codex-bridge\scripts\bridge-cli.mjs wait-any --url-file <launch-url-file> `
  --token-ref <你的tokenRef> --controller codex
```

- `health` 返回 `bindings` 数应等于配置里的绑定数。
- `wait-any` 返回码：`0` 有事件、`3` 到截止、`1` 被拒绝/出错、`2` 用法错。

## 四、回滚（本插件精确回滚）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CodexBridge.ps1 -Rollback
```

- 回滚**只移除本插件自己的标记块**（实测：安装后追加的其它行、其它插件行与注释**逐字节保留**），
  并放回**收据记录的那个**旧 artifact；没有旧 artifact 则移除本次安装的副本。
- 回滚**绑定本插件收据**（`<DshHome>\profiles\node_modules\.dsh-codex-bridge-artifacts\migration.json`），
  **不是**"目录里最新的 .bak" —— 那个可能属于别人后续的改动。
- 若本插件块在安装后被编辑过（并发改同一块）⇒ **明确拒绝回滚**并说明，**不覆盖别人的修改**；
  没有收据同样**拒绝猜测**。此时按提示手工处理该块。
- 旧 artifact 一直保留在上述归档目录，需要时可手工换回。脚本**不删除未知目录**，
  且移动/递归删除前会校验路径位于 profile 的 `node_modules` 或本次 stage 内。

## 五、运行中换会话绑定（**不重启、不中断他人**）

新 DS 会话开始后**不要**再改整个 profile 重载 —— 那会 **dispose 本插件并中断所有在途 ask**，
包括**其它控制方**正在等待的问题。用增量入口：

```powershell
# 加一条自己的绑定（session 必须存活，且 --cwd 是它的真实目录）
node dsh-codex-bridge\scripts\bridge-cli.mjs bind --url-file <launch-url-file> `
  --token-ref <你的tokenRef> --controller codex --session <新sessionId> --cwd <真实目录>

# 换绑：先加新的，成功后再退旧的（加失败则旧绑定原样保留）
node dsh-codex-bridge\scripts\bridge-cli.mjs replace --url-file <launch-url-file> `
  --token-ref <你的tokenRef> --controller codex --session <新sessionId> --cwd <真实目录> --retire <旧bindingId>

# 退掉一条（该绑定仍有待答问题或会话在跑时会拒绝）
node dsh-codex-bridge\scripts\bridge-cli.mjs unbind --url-file <launch-url-file> `
  --token-ref <你的tokenRef> --controller codex --binding-id <bindingId>
```

- **他人不受影响**：变更只改**本插件的一行**、只动**你自己的绑定**；其它控制方的绑定与**活 waiter 保留**。
- **不隐式 cancel**：有待答问题时 `unbind` 返回 409，**不会**替你取消正在做的业务。
- **已持久化**：变更写进 profile，**重启后仍在**；不会"显示成功而重启丢绑定"。
- **越权拒绝**：身份来自凭据；非法 cwd、session 不存活、抢他人 session、动他人绑定都拒绝且**不改任何绑定**。

> **注意**：若该插件的配置被 **home patch 或命令行 `--patch` overlay** 覆盖，`bind`/`unbind` 会返回
> **409 `configuration-overridden`** —— 宿主不允许写 profile，因为那时 profile 已不是 Loader 真正读的层。
> 本机主实例用 **profile patch**（无 `--patch`），可直接使用；若换成 overlay 部署，需改那个 overlay 文件。

## 六、两个控制方（Codex）怎么用

两侧都用同一套接口，只是 `controller` 名与 `tokenRef` 不同。**每次调用只做三件事**：

1. `wait-any` 等到事件（或到截止空手而归，不花模型调用）；
2. 事件是 `question` → 读文本文件、`answer` 回答；是 `delivery`/`error` → 处理并 `confirm`；
3. 需要主动告知对方 → `notify`。

约定要点：

- **确认与交付分离**：`confirm` 只表示「我已收到通知」，**不等于**工作结束；未答复的问题仍可答复。
- **答复是幂等的**：同一问题第二次答复会被拒绝或视为同一结果，**不会**覆盖第一次。
- **`answer` 的 `source` 固定 `codex`**，不允许自报人类。
- **重试**：新通知**不要**写 `--request-id`（服务端分配身份）；只有重试**已发行**事件时才写，
  且**必须**同时给 `--issued-at`（该事件的**原始**发行时间，不是重试时刻）。

## 六、失败时最可能的原因

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `health` 连不上 | 插件未激活 | 查 profile patch 是否写入、YAML 是否可解析 |
| `health` 200 但 `bindings` 为 0 | `controller` 名或凭据引用不匹配 | 核对 `tokenRef` 与 `controller` |
| `bindings` 403 | 自报 `controller` 与凭据解析出的控制方不一致 | 让两者一致 |
| 插件整体不生效、路由 404 | 校验失败（如保留参数非法、重复 owner、目录不符） | 看 Harness 日志中 `refusing to start` / `Validation error` 原文 |
| 回答 409 | 问题已被答复/取消/超时 | 属正常幂等或冲突语义 |
