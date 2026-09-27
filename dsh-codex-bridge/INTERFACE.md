# dsh-codex-bridge：DS↔Codex 双向协作桥

状态：**隔离实例全部验收 GREEN（97/97）；未安装主实例、未重启、未推送。**
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
| GET | `/wait-any?controller=&waitMs=&since=&maxBatch=&deliveryComplete=&acknowledged=` | **跨该控制方所有绑定**等待，任一事件即返回；有界批次 + cursor |
| GET | `/signals/files?controller=` | **文件收件箱**投影（每事件一文件） |
| POST | `/signals/confirm` | `{controller,signalId}` 确认（与投递分离、按事件独立、幂等） |

### DS 侧工具
`ask_codex({question, detail?, timeoutMs?})` → `{status, answer?, source?, questionId, reason?}`。

## 三、合同要点

- **绑定身份**：`{bindingId, sessionId, cwd, controller}` 显式声明；**不由标题/最近窗口推断**；
  一个控制方可有**多个绑定、多个目录**，`(controller,sessionId)` 是身份，**不按目录名合并会话**。
- **状态归属**：提问/答复以原生持久事件（`collab/question`、`collab/answer`、`collab/cancel`、
  `collab/notify`）+ `collabQuestions` 投影持有；**不另维护第二份可写真源**。
- **人类权限不拦截**：`ask_user_question` 与 approval 语义原样；AI 答复必须带 `source:"codex"`，
  **不可伪装用户同意**。
- **幂等/冲突**：同 `questionId` 同内容=幂等；同 id 异内容=冲突（409）；取消后晚答=拒绝。
- **确认与投递分离**：`wait` 返回**不代表**验收通过；只有调用方显式确认才退休事件。
- **完成语义**：`kind:"delivery"` 只有调用方**声明完成**时才唤醒等待（`deliveryComplete=true`）；
  **普通 `turn/end` 不产生交付信号**。
- **文件信号**：每事件一个唯一文件，**先临时写再同目录原子 rename**；按控制方分目录；
  读取**每次重读目录实际状态**，通知只作提示；扫描→订阅→**再扫描**封住竞态。
  文件是**通知投影**，不是业务真源——不因出现文件就批准部署、接受测试或执行命令。
- **有界**：等待有总截止；超时回 `empty:true, reason:"no-new-events"`（不是答复/批准/失败）；
  保留有界（`inboxMaxAgeMs`/`inboxMaxEvents`），**不静默清掉未确认事件**。
- **重启**：重启**不保留假活 Promise**；未答问题仍可读，工具返回 `interrupted` 由控制方按原身份恢复；
  **不重放已执行工具**。

## 四、验收（全部实测，`EXIT=0`）

`node scripts/<suite>.test.mjs`：

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `collab-rules` | 19/19 | 纯函数规则层 |
| `collab-signals` | 27/27 | 信号规则 + 文件收件箱（含扫描/订阅竞态） |
| `collab-multi` | 24/24 | 真机：**5 会话跨 5 目录 + 第二控制方** |
| `collab-loop` | 27/27 | 真机：**真实 `ask_codex` → wait → answer → 同一调用继续** |

另需 `scripts/isolated-instance.mjs`（可丢弃 home + `--patch` overlay）与
`scripts/scripted-model/`（**测试专用**可控 provider，不可用于生产）。

## 五、限制（如实）

- **未安装/未启用**：主实例仍跑旧的单向版本，需 root 审核后由外部控制方安装并重启。
- **Codex 侧未验证**：若 Codex 回合已结束或 App 已关闭，**写文件不会自动唤醒它**；本能力
  **不保证**、也**不造计划任务**。
- 文件收件箱需要配置 `inboxRoot`（本机运行路径，不入库）。
- 多控制方**独立**：不形成任何全局总控；解绑/取消只影响指定绑定。
- 未做：跨进程（多实例）共享同一 inbox 的并发压测；Codex 真实端到端联调（本轮只做隔离实例）。
