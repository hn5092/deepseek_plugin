# 主实例启用步骤（root 外部执行）

本文件是**给 root 的执行清单**，不含任何密钥值。所有路径按需替换为真实值。

## 前置事实（已在隔离实例实测）

- **装插件不需要重启主服务。** Harness 会 watch profile 的 `cordis.patch.yml`，文件一变就重新协调
  Loader。实测：同一进程内从「插件不存在（404）」变为「路由 200、既有 session 与历史仍在、
  双向接口可用」，PID 不变。
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
  写前备份、写后用 Harness 自带 js-yaml 复核；**健康失败自动精确回滚本插件**。
- **`-HealthUrl` 用不上时**：安装后手动确认
  `Invoke-WebRequest http://127.0.0.1:43132/codex-bridge/health`（未登录返回 401 属正常鉴权，不是失败）。

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

- 恢复**最近一次备份**的 patch 文件（实测与安装前 SHA256 一致），并把**上一个 artifact 放回**；
  若此前没有 artifact，则移除本次安装的副本。
- 旧 artifact 一直保留在 `<DshHome>\profiles\node_modules\.dsh-codex-bridge-artifacts\`，
  需要时可手工换回。脚本**不删除未知目录**。

## 五、两个控制方（Codex）怎么用

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
