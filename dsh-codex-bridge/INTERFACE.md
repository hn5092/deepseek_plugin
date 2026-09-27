# dsh-codex-bridge：DS↔Codex 双向协作桥

状态：**隔离实例全部验收 GREEN（18 套 401/401，全部 EXIT=0）；未安装主实例、未重启、未推送。**
作者源码：`D:\workspace\_tools\deepseek_plugin\dsh-codex-bridge\`（唯一）。

## 零之一、重试合同（所有入口同一语义）

- **普通新通知不写 `requestId`**：服务端分配身份（`kind-<generation>-<seq>`），调用方**不必**手写内部序号。
- **自定义 `requestId` 是"重试已发行事件"的声明**，因此**必须同时给 `issuedAt`**（该事件的**原始**发行时间）：
  - 记录**仍在** → **精确幂等**（返回同一记录，不新建、不唤醒）；
  - 记录**已被回收** → 按 `issuedAt` 判**过期**（`event-expired`），**不重建**；
  - **缺 `issuedAt`** → **拒绝**（`event-id-without-issue-time`）。**没有"当作新事件"的开关** ——
    那会是绕过过期检查的正式后门。
- **禁止用重试发生时刻充当 `issuedAt`**。原生 producer 取**原生事件自身的时间**（`event.time`）；
  事件不带时间时**不使用可重试身份**，改由服务端分配 id（宁可一个新事件，也不伪造时间）。
- **如实声明的界限**：记录已回收后，调用方给**窗口内**的 `issuedAt` 与"合法新建自定义 id"**不可区分**，
  故被接受为新记录。**有限保留与任意字符串的无限去重不可兼得**；上面的规则让常见路径安全，
  超窗重试仍被拒绝。

## 零之二、加载先于一切生产者

`apply` **最先** `state.load()`，**早于**注册工具、原生事件 observer 与路由 —— 因为这三者都是生产者。
- **load 失败即拒绝服务**：不以空缓存继续（那会从空基线上覆盖已确认记录）；生产者返回
  `store-not-loaded:*`，HTTP 回 503。
- 由此保证：**重启后模型 tool / 原生事件先到**时，看到的是**已加载的权威状态**，不会复活已确认记录。

## 零之三、终态边界即回收边界

`settleBusiness`（答复 / 取消 / 超时**共用**）内部顺序固定：**CAS 落盘 → 用已确认结果 settle 活 waiter →
再回收**，并返回**赢家快照**（回收删掉记录也不会让调用方读成 `unknown`）。
⇒ **先批量 confirm、随后才 answer/timeout 且不再 confirm** 的问题，也会在终态边界被正常收尾。

## 零之四、配置与故障的初始化边界

- **保留窗口在构造时一次注入**（`BridgeState({..., retention: {maxAgeMs, maxEvents}})`），
  `publish` 判过期与 `reclaim` 收尾**消费同一份**。**不是"某条路径跑过才生效"的默认值** ——
  否则全新实例与刚重启的实例会按内建默认（7 天）判断重试是否过期。
- **只有"明确的 ENOENT 且无记录"才算空存储**。`EACCES`/`EPERM`/`ENOTDIR`/IO 错误/损坏记录
  **明确上报并拒绝生产**（HTTP 503，`detail` 保留**原始错误文本**），**不当作空**。
  ⇒ 不会出现"读不到记录 → 以为空 → 覆盖已有记录"。
- **不再用 `existsSync`**（生产路径已无）：文件存在但不可读与"不存在"是不同事实。`readJson` 失败时
  **带出 `error.code`**，`missing` 只认 `ENOENT`；**不按错误消息里的路径字面量分类**（消息含路径，
  路径里出现 `ENOENT` 会被误判）。
- **有记录却缺 meta = 序号历史丢失**：**运行期**由 `reserveSeq` 在**所有 producer 共用的分配边界**
  拒绝（先 `hasRecords()` 探测，再 `readMeta({recordsPresent})`），**不默默从 seq 1 重建** ——
  避免覆盖已有服务端事件 ID。⇒ **模型工具与原生事件在未经 controller reload 时同样被拒**，
  不是只有 HTTP reload 才拦得住；失败的 ask 返回**具体存储错误**，**不挂起**。
- **`reclaim` 也检查可读性**：读不到记录时返回原因，不谎报"没有到期项"。

## 零之五、`generation` 的定位（不为概念扩功能）

`generation` 是**服务端 id 的持久命名空间**，**不是换代机制**：**换代由 `bindingId` + `current` 保证**
（失效绑定永不被选中；一个 session 恰有一个答复 owner）。**当前无任何调用方需要换代**，故
**已删除无人调用的 `advanceGeneration`**，不拿未调用方法当验收证据。

## 零之六、状态模型（唯一合同）

每个事件是**一条原子记录**（一个文件、temp+rename），**两条独立轴**：

```
id, seq, generation, bindingId, controller, sessionId, cwd,
kind(question|delivery|error), sourceIdentity(goalId?/requestId?/sessionEventSeq?),
createdAt, notification(outstanding|confirmed),
business(question: pending|answered|cancelled|expired; notice: terminal),
answer?, confirmedAt?, terminalAt?
```

- **`notification` 与 `business` 互不代表**：确认通知**不**结束工作；工作结束**不**等于已确认。
  ⇒ 确认一个**尚未答复**的问题后，问题**仍可答复**（旧的三文件设计正是在此处删掉了问题本身）。
- 内存只是该记录的**可重建缓存**；`waiters` 纯内存、**不恢复**（死掉的进程无法续跑工具调用，如实回报）。
- **`ControllerMeta`**：`nextSeq`/`generation` **只增不减**；**先原子预留 seq 再写事件**（崩溃留空洞可接受）；
  **回收不降低高水位**，故调用方 cursor 含义不变；**换代**使旧 generation 的身份明确 stale。
- **不写入会话日志**：本 harness 拒绝读取含未知类型且未标 `ignorable` 的日志，而 `Session.append`
  **无法设置该标记**，写自定义事件会让会话**永久不可读**（已实测复现）。

四个状态边界**全部归 store**：
1. **产生**：完整记录**原子持久成功**后再投影/唤醒；持久失败**不发布成功**。
2. **答/取消/超时**：`pending → 终态` 的 **CAS**（首个终态胜出，晚者拒绝），再 settle 活 waiter；
   **超时写 `expired`**、取消写 `cancelled`。
3. **确认**：仅 `notification → confirmed`，重复**幂等**，**pending 问题保留**。
4. **回收**：仅 `confirmed` **且**终态 **且**过 `maxAgeMs` **且**超出最近 `maxEvents` 窗口；
   **pending/unconfirmed 永不因容量删除**；单条失败**只多留整条**（一记录=一文件，无部分孤儿）；
   成功后内存缓存**从权威重建**。

## 零之七、投影与有限保留的边界（如实声明）

- **inbox 只是 outstanding 记录的投影**；`/signals`、`/signals/files`、`/wait-any` **共用同一 `state.project()`**：
  记录有文件无→**补**；记录 confirmed/已回收→**不交付**；**文件有记录无→只报告 ghost，不交付**。
- **有限保留与无限期任意 `requestId` 精确去重不可兼得。** 面向可靠问答/信号，不承诺无限历史：
  服务端生成身份；记录在则**精确幂等**；**已回收 ID 返回 410 expired/retired**。HTTP `notify` 的任意
  `requestId` **仅在保留窗口内去重**，超窗重试需原 `issuedAt`，否则拒绝为过期；**不用无限 tombstone 伪装有界**。
- **保留参数为有限整数**：`maxAgeMs >= 0`；`maxEvents >= 1`。非法值使**插件拒绝激活**（宿主记录
  `refusing to start` / `Validation error`，桥路由不存在），不静默接受。

## 一、它解决什么

DS 在一个绑定目录的会话里发出技术问题 → Codex 当前的等待动作**立即**收到 → 按原问题身份答复 →
**原工具调用拿到结果并继续**（不另开会话、不重放已执行工具、不塞给错误 Goal）。DS 也能公开通知
「完整交付」或「异常停止」；**普通轮次结束不算完成**。

支持**多开**：一个控制方绑定多个 DS 会话（可跨多个目录），任一会话出现待答/交付/异常即唤醒，
不逐个会话串行等待。

## 二、接口

### 既有（未改语义）
| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/codex-bridge/health` | 存活、绑定数、inbox 根、全部路由 |
| GET | `/codex-bridge/sessions` | 本 shell 可到达的会话 id |
| POST | `/codex-bridge/send` | 往会话投递消息（复用 `sessionController.prompt`） |

### 新增：协作控制面（前缀 `/codex-collab`，**全部经 `connection.admit` 鉴权**）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/bindings?controller=` | 该控制方**自己的**绑定（无 controller 只回计数与控制器名） |
| GET | `/questions?sessionId=&controller=&since=` | 该绑定的待答问题（backlog 优先） |
| GET | `/wait?sessionId=&controller=&waitMs=` | 单会话等待，backlog 立即返回，否则有界等待 |
| POST | `/answer` | `{questionId,text,source,controller}` → 幂等/冲突/拒绝语义 |
| POST | `/notify` | `{sessionId,controller,kind:"delivery"\|"error",text?,goalId?}` **显式**通知 |
| GET | `/signals?controller=&acknowledged=` | 该控制方全部绑定的事件投影 |
| GET | `/wait-any?controller=&waitMs=&since=&maxBatch=&acknowledged=` | **跨该控制方所有绑定**等待，任一事件（**含 delivery**）即返回；有界批次 + cursor |
| GET | `/signals/files?controller=` | **文件收件箱**投影（每事件一文件） |
| POST | `/signals/confirm` | `{controller,signalId}` 确认（与投递分离、按事件独立、幂等） |
| POST | `/bindings/bind` | **运行中增量**加一条**自己的**绑定：`{sessionId,cwd,controller,tokenRef,bindingId?}`；session 必须存活且 **cwd 与真实目录一致** |
| POST | `/bindings/unbind` | **运行中增量**移除一条**自己的**绑定：`{bindingId,controller}`；**该绑定有待答问题或会话在跑 ⇒ 拒绝** |

### 运行中换绑定（**不 dispose、不中断他人**）

- 换会话**不再需要改整个 profile 并重载**。`bindings` 在 schema 中声明为 **volatile**，配置变更由 Loader
  **提交进正在运行的实例**，因此**在途 ask（含其它控制方的 pending 问题）不被中断**。
- 持久化走**宿主自己的配置 owner** `ctx.configEditor.edit(entry, ...)`：只改**本插件这一行**，
  其它插件行与无关字段逐字保留；**不新增第二份可写绑定表**（profile 配置仍是唯一权威）。
- **安全**：身份取自 `x-controller-token`，自报 `controller` 必须一致；只能增删**自己的**绑定；
  非法 cwd / session 不存活 / 抢他人 session / 动他人绑定 **一律拒绝且不改变任何绑定**。
- **不隐式 cancel**：`unbind` 在该绑定仍有**待答问题**或**会话正在跑**时拒绝；要退绑定先让工作结束。
- **失败可恢复**：持久化失败**如实返回错误**（不谎报成功）；`replace` **先加新绑定、成功后再退旧的**，
  加失败则旧绑定**原样保留**。
- **准确限制**：若该插件的配置被 **home patch 或命令行 `--patch` overlay** 覆盖（`configEditor` 会拒绝写
  profile，因为那时 profile 已不是 Loader 真正读的层），接口返回 **409 `configuration-overridden`** 及原因，
  **不静默无效、不谎报已存**。此时应改那个覆盖层，或改为 profile-owned 部署。

### DS 侧工具
`ask_codex({question, detail?, timeoutMs?})` → `{status, answer?, source?, questionId, reason?}`。

## 三、合同要点

- **控制方身份由凭据决定，不由自报决定**：`connection.admit` 只证明请求来自 operator（**恒为同一 peer**，
  不区分控制方），因此每个绑定声明 `tokenRef`（凭据**引用**，值经 `ctx.credentials` 解析，**不入 Git/日志/会话**）。
  请求须带 `x-controller-token`；服务端用解析出的控制方身份，**自报的 `controller` 必须与之一致**（否则 403）。
  ⇒ 持有 B 合法凭据者**无法**借自报 A 读取/答复/确认 A 的事件。
- **AI 来源由服务端写死 `codex`**；调用方传 `source:"user"` 会被覆盖，**机器不能伪造人类同意**；人类仍走原生
  `ask_user_question`/approval 入口，本插件不拦截。
- **绑定身份**：`{bindingId, sessionId, cwd, controller, tokenRef}`；一个控制方可**多绑定、多目录**，
  `(controller,sessionId)` 是身份，**不按目录名合并会话**。同一 session **两个答复 owner 直接拒绝**
  （该 session 的绑定全部剔除 = 零 owner，fail-closed）；交接用 `current:false`。
- **权威状态在插件自有持久存储**（`lib/store.js`）：`signals/`、`confirmations/`、`questions/`，
  每记录一文件、**先临时写再同目录原子 rename**、按稳定 id 覆盖 ⇒ 重试幂等。
  **不写入会话日志**：本 harness 拒绝读取含未知事件类型且未标 `ignorable` 的日志，而 `Session.append`
  **无法设置该标记**，写自定义事件会让会话**永久不可读**（已实测复现）。
- **幂等/冲突**：同 `questionId` 同内容=幂等；同 id 异内容=冲突（409）；取消后晚答=拒绝。
- **确认与投递分离**：`wait` 返回**不代表**验收通过；确认写权威记录（**重启后仍生效**），重复确认幂等。
- **完成语义（正式 producer）**：
  - **原生 `goal/change` 且 `phase==="complete"`** → `delivery`（带 Goal 身份）；
  - **原生 `turn/end` 且 reason 为终态 `error`** → `error`；
  - **普通 `turn/end` 不产生任何信号**；
  - DS 侧 `notify_controller` 工具为显式补充；交付/异常均可由正式 caller 产生。
- **有界**：等待有总截止；超时回 `empty:true, reason:"no-new-events"`（不是答复/批准/失败）。
- **重启**：确认不重现、未确认可补收、**旧 cursor 不漏新事件**、**不重放**；未恢复的工具等待**不复活**，
  答复照常落盘并回 `delivered:false` 说明本进程无活等待。

## 三之二、部署与消费入口（运维面，**不新增消息仓**）

### 热加载结论（**隔离实例实测**，非推测）

- Harness 的 profile 补丁层 `<home>/profiles/<profile>/cordis.patch.yml` 是**被 watch 的**：
  启动代码对该文件（及 `<home>/cordis.patch.yml`）注册观察者，变化时调用 `reconcileProfilePatches`
  → Loader 激活，注释原文即「**hot-reloaded on long-lived surfaces**」。
- **首装实测（`collab-hotload` 11/11）**：实例启动时**不含**本插件（路由 404）→ 只有该文件被改写 →
  **同一 PID**（无宿主重启）内路由转为 200、**既有 session 与其历史仍在**、绑定可读、
  notify/signals/wait 全可用。
- **升级实测（`collab-upgrade` 33/33）—— 关键限制**：宿主**已经 import 过**该模块后，
  Loader 重载按名字重新 import，而 **Node ESM 缓存返回已加载的旧模块** ⇒ 运行中的宿主
  **继续提供旧 artifact**。实测序列：装**旧单向桥** → 启动宿主 → 换新 artifact + 触发重载 ⇒
  **collab 路由仍不存在**，而 **patch 层确实重载**（移除该行 health 即 404）、**session 与进程身份保留**。
  ⇒ **首装可热加载；升级已加载过的插件必须重启一次 Harness。**
  安装脚本对此返回 **`restart-required`（退出码 3）**，**不谎称热升级成功**，也**不回滚**正确的磁盘安装。
- **准确限制**：`--patch <file>` 这类**启动参数**补丁**只在启动时读一次**，改写它**不会**热加载 ——
  必须写 **profile 自己的** `cordis.patch.yml`。这是本插件安装入口的做法。

### `scripts/Install-CodexBridge.ps1`（**可逆**安装，root 外部执行）

```powershell
# 安装：精确提交 + 配置片段（可选 -HealthUrl 做健康门，失败自动回滚本插件）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CodexBridge.ps1 `
  -Commit <exact-commit> -ControllerConfig <path-to-config.yml> -HealthUrl <launch-url-file>
# 回滚：恢复最近备份 + 放回原 artifact
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CodexBridge.ps1 -Rollback
```

- 用 `git archive <commit>:<pkg>` **从精确提交**取干净产物（**不含** `*.test.mjs`、日志、scratch）。
- 只改**本插件自己的 delim 块**：其它插件行与注释**逐字节保留**（实测）。
- 写前**备份**、写后**用 harness 自带 js-yaml 复核 YAML**；不顺 ⇒ **立即还原备份**并报错。
- 旧 artifact **移入** `.dsh-codex-bridge-artifacts/` 而非删除；**不删未知目录**。
- **健康门**用 CLI **先登录换 cookie**，要求响应含 `codex-collab` 路由与 `bindings`（**旧单向桥的匿名 200 不算通过**）；**首装**失败⇒精确回滚，**升级**失败⇒报 `restart-required`（退出码 3）而不回滚正确磁盘安装。
- 实测：回滚后 patch 文件与安装前 **SHA256 完全一致**，产物已移除。

### `scripts/bridge-cli.mjs`（薄消费入口，**只调用本桥 HTTP**）

| 命令 | 语义 |
| --- | --- |
| `health` | 存活 / 绑定数 / 路由（**无需凭据**，先探活） |
| `bindings` | 该控制方自己的绑定 |
| `wait-any` | **跨会话**等待：**总截止 20 分钟**上限 + **底层有界长轮询**；**无事件则返回码 3 且无输出**（不调用模型） |
| `answer` | 文本**从文件读**，`source` **固定 `codex`** |
| `confirm` | **单事件**确认 |
| `notify` | **显式**通知；新通知**不写** `--request-id`（服务端分配）；重试必须给 `--issued-at` |

- 启动 URL **从本机文件读**（不接命令行）；凭据只给**引用名** `--token-ref`，值从
  `<home>/.credentials.yaml` 或环境解析，**不进命令行、不打印**（实测断言）。
- 配置示例见 `bridge-config.example.yml`（**只含引用**，无任何密钥值）。

## 四、验收（全部实测，`EXIT=0`，合计 401/401）

`node scripts/<suite>.test.mjs`：

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `collab-rules` | 30/30 | 纯函数规则层：peer 身份反例 + **失效绑定在真正选择处被排除** |
| `collab-signals` | 34/34 | 规则层；不再导出按文件年龄的 prune 与无人消费的 watcher |
| `collab-multi` | 31/31 | 真机：5 会话跨 5 目录 + 第二控制方；**匿/错/冒名一律拒绝** |
| `collab-loop` | 29/29 | 真机：**真实 `ask_codex` → wait → 答 → 同一调用继续** |
| `collab-restart` | 14/14 | 真停 host → 同 home 重启：确认不重现、补收、cursor、无重放 |
| `collab-pending-restart` | 16/16 | **真 `ask_codex` 留下 pending 问题 → 真重启**：问题与**其信号**一并重建 |
| `collab-durability` | 20/20 | store 不可写则拒绝；**真实工具返回 `ok:false`**；**store 可写但 inbox 不可写**：问题保留、API 仍可取、**工具如实报 `deliveryWarning`** |
| `collab-native` | 9/9 | 原生 Goal 完成 → delivery（带 Goal 身份）；普通 turn 结束无信号 |
| `collab-handover` | 12/12 | **失效绑定排在最前仍不命中**：旧 owner 读/答 403 |
| `collab-five` | 8/8 | **5 会话并发真 ask → `wait-any` 批收 → 逐问独立答复 → 各原调用恰好继续一次、只读到自己的答复** |
| `collab-projection` | 17/17 | **投影修复**（文件被删后读回自动补建）、**ghost 不交付只上报**、**有界回收**（两轴：确认且终态且过双界才回收；**未确认/已确认但仍 pending 均永不因上限删除**）、**高水位不降** |
| **`collab-retention`** | **13/13** | **保留参数非法则插件拒绝激活**；**真 ask → 只确认不答复 → 小窗口回收 → 问题仍可答、原工具调用恰好继续一次** |
| **`collab-callers`** | **35/35** | **回收后用同 `requestId` 重试：缺 `issuedAt` 拒绝、给原 `issuedAt` 判过期、均不重建**；**批量 confirm 后仅 answer/timeout（不再 confirm）仍在终态边界收尾**；**保留中的重复=幂等 200 且不重新 outstanding，真正超窗已回收的重复=过期拒绝**；**配置窗口在全新实例与重启后的首写即生效**；**读不到的 store 拒绝生产并保留原始错误**；未确认记录在多次回收后仍在 |
| **`collab-meta-loss`** | **23/23** | **运行期 meta 丢失**：producer（模型工具/原生事件）**未经任何 collaboration HTTP reload** 即被拒，**已有记录与游标不变、不重建 seq 1**；共享分配边界独立反例；fresh store 仍正常；失效 ask **返回具体存储错误且不挂起** |
| **`collab-hotload`** | **11/11** | **热加载实测**：启动时无插件（404）→ 只改 profile patch → **同一 PID**（无重启）内路由 200、**既有 session 与历史仍在**、绑定/notify/signals/wait 全可用；`--patch` 启动参数文件**不会**热加载（准确限制） |
| **`collab-ops`** | **25/25** | **消费与运维**：CLI health/bindings/真实 ask→wait-any→answer→**同 tool 继续**/confirm/notify；**不误吞另一会话**；**空截止到达且无输出、无模型调用**；**凭据不出现在任何输出**；安装精确提交（其它插件行保留、不含 tests）→ 健康 → 回滚**逐字节还原** |
| **`collab-upgrade`** | **33/33** | **升级真实反例**：先装**旧单向桥**→启动宿主→换新 artifact 触发重载 ⇒ **已 import 的模块不换**（collab 仍 404），而 **patch 层确实重载**（移行即 404）、session 与进程身份保留；**健康门**拒匿名旧 200、要求 collab 路由+bindings；**回滚绑定本插件收据**（只移本块、恢复收据记录的旧 artifact、**并发改同块即拒绝**、无收据拒绝猜测）|
| **`collab-livebind`** | **41/41** | **运行中增量绑定**：B 的**真实在途 ask** 等待时 A 增量绑定新 session ⇒ **B 原问题仍可答、原工具恰好继续一次**、A 新 session 真实 ask/wait/answer 通；**PID 不变**；非法 cwd/不存活 session/抢他人/动他人绑定**全拒绝且不改绑定**；**unbind 有待答问题即拒绝（不隐式 cancel）**；已退绑定不能代答而其**历史保留**；换绑定**已持久化**；**overlay 部署返回 409 configuration-overridden 且不谎报已存** |
另需 `scripts/isolated-instance.mjs`（可丢弃或 caller-owned home + `--patch` overlay，**真 SIGTERM → 等退出 →
有界 SIGKILL → 复核**的 stop，**回收本次自有孙进程**，失败日志复制到 caller 指定的证据目录，并导出
`stopIsClean()` 供各套件共用同一收据判定）与 `scripts/scripted-model/`
（**测试专用**可控 provider：脚本状态**按 `options.sessionId` 分片**，排除辅助调用，**每会话恰好 ask 一次**）。

## 五、限制（如实）

- **未安装/未启用**：主实例仍跑旧的单向版本，需 root 审核后由外部控制方安装并重启。
- **Codex 侧未验证**：若 Codex 回合已结束或 App 已关闭，**写文件不会自动唤醒它**；本能力
  **不保证**、也**不造计划任务**。
- `inboxRoot`/`storeRoot` 需配置（本机运行路径，不入库）。
- 多控制方**独立**：不形成任何全局总控；解绑/取消只影响指定绑定。
- **有限保留**：已回收事件的迟到重试会被判 `expired/retired`（410），**不承诺无限历史**。
- 未做：跨进程（多实例）共享同一 store 的并发压测；Codex 真实端到端联调（本轮只做隔离实例）。
