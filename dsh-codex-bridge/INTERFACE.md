# dsh-codex-bridge：DS↔Codex 双向协作桥

状态：**隔离实例全部验收 GREEN（11 套 219/219，全部 EXIT=0）；未安装主实例、未重启、未推送。**
作者源码：`D:\workspace\_tools\deepseek_plugin\dsh-codex-bridge\`（唯一）。

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

## 四、验收（全部实测，`EXIT=0`，合计 219/219）

`node scripts/<suite>.test.mjs`：

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `collab-rules` | 30/30 | 纯函数规则层：peer 身份反例 + **失效绑定在真正选择处被排除** |
| `collab-signals` | 36/36 | 信号规则 + 文件收件箱（扫描/订阅竞态、清理断言） |
| `collab-multi` | 31/31 | 真机：5 会话跨 5 目录 + 第二控制方；**匿/错/冒名一律拒绝** |
| `collab-loop` | 29/29 | 真机：**真实 `ask_codex` → wait → 答 → 同一调用继续** |
| `collab-restart` | 14/14 | 真停 host → 同 home 重启：确认不重现、补收、cursor、无重放 |
| `collab-pending-restart` | 16/16 | **真 `ask_codex` 留下 pending 问题 → 真重启**：问题与**其信号**一并重建 |
| `collab-durability` | 20/20 | store 不可写则拒绝；**真实工具返回 `ok:false`**；**store 可写但 inbox 不可写**：问题保留、API 仍可取、**工具如实报 `deliveryWarning`** |
| `collab-native` | 9/9 | 原生 Goal 完成 → delivery（带 Goal 身份）；普通 turn 结束无信号 |
| `collab-handover` | 12/12 | **失效绑定排在最前仍不命中**：旧 owner 读/答 403 |
| **`collab-five`** | **8/8** | **5 会话并发真 ask → `wait-any` 批收 → 逐问独立答复 → 各原调用恰好继续一次、只读到自己的答复** |
| **`collab-projection`** | **14/14** | **投影修复**（文件被删后读回自动补建）、**确认过滤**（残留文件不复活已确认事件）、**有界回收**（已确认且过界才回收；**未确认永不因上限删除**） |

另需 `scripts/isolated-instance.mjs`（可丢弃或 caller-owned home + `--patch` overlay，**真 SIGTERM → 等退出 →
有界 SIGKILL → 复核**的 stop，**回收本次自有孙进程**，失败日志复制到 caller 指定的证据目录，并导出
`stopIsClean()` 供各套件共用同一收据判定）与 `scripts/scripted-model/`
（**测试专用**可控 provider：脚本状态**按 `options.sessionId` 分片**，排除辅助调用，**每会话恰好 ask 一次**）。

## 五、限制（如实）

- **未安装/未启用**：主实例仍跑旧的单向版本，需 root 审核后由外部控制方安装并重启。
- **Codex 侧未验证**：若 Codex 回合已结束或 App 已关闭，**写文件不会自动唤醒它**；本能力
  **不保证**、也**不造计划任务**。
- 文件收件箱需要配置 `inboxRoot`（本机运行路径，不入库）。
- 多控制方**独立**：不形成任何全局总控；解绑/取消只影响指定绑定。
- 未做：跨进程（多实例）共享同一 inbox 的并发压测；Codex 真实端到端联调（本轮只做隔离实例）。
