# DSH-Tick 崩溃关联排查 · 结论与补丁建议

> 开发交接笔记：面向维护者，记录决策过程、验证证据与踩坑。使用者看 `README.md` 即可。


> **校对对象**：`dsh-tick-崩溃关联排查.md`（下称"原文档"）
> **排查方式**：只读分析（未修改任何代码）
> **后续**：§6 的 P0 / P1 已于 2026-11-17 实施并通过验证，状态见 §6 表格；P2 / P3 未做。
> **时间**：2026-11-17
> **环境**：DSH Desktop 0.2.2-rc.3 / Electron 44.7.0 / Node 24.21.0 / Windows x64

---

## 0. 三句话结论

1. **tick 不是崩溃的必要条件**——有两次崩溃发生在 `tick` 已被停用、无任何计时器运行期间（有 operation journal 硬证据）。
2. **但当前代码确有两处可逃逸的异步异常**（§5 A、B），其后果与观测到的崩溃完全一致：DSH 对 `unhandledRejection` 的处理是**直接 `exit(1)`**，Host 静默消失，主进程只看到 `ECONNRESET`。这两处应当加固。
3. **原文档有两处需要修正**（§2）：一是时区差 8 小时导致时间线错位，二是 §4 的报错来自早已修掉的旧构建，用它推断当前风险会误导方向。

---

## 1. 硬证据：tick 停用期间仍然崩

原文档 §3 记「11-16 23:43/23:44 tick 无加载记录」。实际不是"没加载"，而是**被主动停用**。profile 的 operation journal 原文：

```
15:41:09.406Z  include:tick  stage=enable  enabled=false  phase=started
15:41:09.685Z  include:tick  stage=enable  enabled=false  phase=settled  application="applied"
15:43:56.460Z  ← 崩溃 #2
15:44:10.430Z  ← 崩溃 #3
```

- 停用发生在崩溃前 **2 分 47 秒**；
- 停用后 tick 的 `apply` 已卸载，`setInterval` 被 `ctx.effect` 清理，没有任何计时器在跑；
- 同一份 journal 里，此后到崩溃之间无任何 tick 相关记录。

**结论**：至少这两次崩溃与 tick 的运行无关。原文档"tick 是重点嫌疑"的判断，至少应降级为"tick 可能是放大器，非必要条件"。

> 原文档自己也观察到「23:43 两次 tick 未加载，说明不是只有 tick 能触发」——这条观察是对的，结论没有顺着它走。

---

## 2. 对原文档的两处修正

### 2.1 时区错位（会让时间线看起来比实际更"咬合"）

`tick.log` 的时间戳是 `new Date().toISOString()`，即 **UTC**；原文档 §3 表格里的时间是**本地（UTC+8）**。

| 原文档写 | tick.log 实际对应（UTC） | 换算成本地 |
|---|---|---|
| tick 于 18:05:17 加载 | `2026-11-17T10:05:17.465Z` | 18:05:17 |
| 18:05:23 挂起告警 | `2026-11-17T10:05:23.997Z` | 18:05:23 |
| 18:05:33 崩溃 | — | 18:05:33 |
| tick 于 18:05:44 加载 | `2026-11-17T10:05:44.926Z` | 18:05:44 |
| 18:05:53 打 token 累计 | `2026-11-17T10:05:53.401Z` | 18:05:53 |

换算后原文档的结论基本成立，但要知道：**直接拿文档时间去 grep tick.log 是搜不到的**，必须先减 8 小时。

### 2.2 §4 的报错属于旧构建，当前代码里不存在

原文档 §4 引用的三行日志：

```
[info] 唤醒尝试 → session-1f42f947-…；sessionController 方法：ctx,name,typertRemote,…
[warn] prompt() 失败：Cannot read properties of undefined (reading 'throwIfAborted')
[info] resolveAgent 返回键：agent
[warn] tj_7f8d65ec 处理失败：message "undefined" is already pending
```

对当前 `<目录>\dsh-tick` 全库 grep `唤醒尝试|resolveAgent|sessionController 方法|agent\.inject`，**只命中 1 处，且是一行解释性注释**（说明为什么不再用 `agent.inject` 兜底）。

时间线：

- `2026-11-16T15:30–15:40`（本地 23:30–23:40）：旧构建每 15 秒重试一次，即原文档看到的那批日志；
- `2026-11-16T15:41:09`（本地 23:41）：该构建被停用；
- 之后代码重写：`prompt(request, signal)` 补上 `AbortSignal` 参数、移除 `agent.inject` 兜底、加失败退避、扫描间隔改 1 分钟。

**结论**：§4 描述的"每 15 秒唤醒重试循环"在**当前构建里不可能发生**，不能作为当前崩溃的推断依据。

---

## 3. 崩溃时刻 tick 到底在做什么

### 崩溃 #4（本地 18:05:33）

```
10:05:17.465Z 已注册 6 个工具 / 已加载
10:05:23.329Z 设置页数据通道已就绪     ← webServer 就绪用了约 6 秒
10:05:23.997Z [warn] 检测到长时间挂起：距上次扫描约 866 分钟，本轮按补偿处理
              ← 之后 tick 再也没有日志；约 9 秒后崩溃
```

关键点：**没有出现「今日会话 token 累计」这一行**。该行在统计成功且值变化时必打，所以这 9 秒里 tick 卡在 `tokensToday()` 内部（翻会话日志），直到进程消失。

### 崩溃 #5（本地 18:05:53）

```
10:05:44.926Z 已注册 6 个工具 / 已加载
10:05:53.088Z 主进程写出 crash 日志（判失败）
10:05:53.401Z [info] 今日会话 token 累计：10,986,496   ← 0.3 秒后 Host 仍在写日志
```

**这里有个重要推论**：主进程判失败的时刻，Host **还活着**并且还在推进工作。

所以 Host 不是"被杀死/崩掉"，更可能是**握手那条连接被重置（RST），主进程先放弃退出，然后把 Host 一起带走**。这与原文档 §2「Host 在发出 ready 之后、完成握手之前就死了」的推断不完全一致——至少 #5 不是。

---

## 4. 冷启动扫描：崩溃窗口里唯一的重活

`tokensToday()` 是本插件唯一的重量级启动动作：

| 项 | 值 |
|---|---|
| 作用 | 读会话日志里 `assistant/message` 的 `usage`，累加当日 token（预算闸的数据源） |
| 规模 | 每页 200 条事件，最多 8 页 |
| 实测耗时 | **5–9 秒**（崩溃 #4 是 9 秒未出结果） |
| 会话日志大小 | 5.6 MB（zstd 压缩） |
| 首次执行时机 | `apply` 后 3 秒 |
| 缓存 | 5 分钟 |

**不是 OOM**：会话日志才 5.6MB，Host 基线 rss 约 330MB（黑匣子心跳数据）。更像是**启动窗口内的事件循环/IO 争用**，或握手期间 Host 内部连接被重置。

**为什么只有"开机后首次启动"明显**：冷启动时文件缓存是冷的、其他插件同时在启动、`lastScanAt` 距今很久必然触发"挂起补偿"分支。热启动时同一段代码耗时不到 1 秒（10:30、10:32、10:38 等多次启动均为亚秒级）。

---

## 5. 当前代码的异常逃逸面

DSH Host 侧（`dsh-app-boot`）对未捕获异常的处理是：

```js
process.on('unhandledRejection', onRejection)  // → stderr + exit(1)
process.on('uncaughtException', onException)   // → stderr + exit(1)
```

因此**任何**逃逸的 Promise 拒绝都会让 Host 直接退出，且 stderr 在本次场景中不可得。以下按实际风险排序。

### A. HTTP handler 的 `catch` 里再调 `sendJson`（**建议修**）

位置：`index.js:905 / 918 / 1034 / 1102`

```js
handler: async (req, res) => {
  try { … }
  catch (error) {
    log('warn', …)
    sendJson(res, 500, { … })   // ← 若响应已结束/客户端已断开，这里会抛
  }
}
```

若请求被中断（页面刷新、关闭设置页、启动过程中渲染层重载），`res.writeHead()` 会抛 `ERR_STREAM_DESTROYED` / write-after-end。这个抛发生在 **catch 块内**，于是 async handler 返回的 Promise 变成 rejected；`webServer` 未必接住 → `unhandledRejection` → Host exit(1)。

**改法**：`sendJson` 内部包一层 try/catch，或在每个 handler 外层再兜一层；无论如何都不能让异常从 handler 逃逸。

### B. `archivedSessionIds()` 的 abort 时机（**建议修**）

位置：`index.js:212–226`

```js
for await (const frame of workspaceController.follow(controller.signal)) {
  if (frame?.type !== 'baseline') continue
  …
  return ids            // ← 从 for await 里 return，迭代器 return() 被调用
} finally {
  clearTimeout(timer)
  controller.abort()    // ← 紧接其后 abort
}
```

从 `for await` 内部 `return` 时，会先调用迭代器的 `return()`；若宿主流实现在 abort 时还有挂起的内部 Promise 并让它 reject，而消费方已经退出循环，这个拒绝可能无人接管。

**改法**：拿到 baseline 后先 `controller.abort()` 让流自然结束、再退出循环；或不用 `for await`，用一次性订阅 + 显式取消 + 对迭代器 `next()` 的 Promise 做兜底。

### C. `setTimeout(tick, 3000)` 未在 dispose 清理（**低风险，可不改**）

位置：`index.js:1125`。清理函数只 `clearInterval`，没清这个 3 秒定时器。但 `tick` 开头有 `if (stopped) return`，且整体在 try/catch 内，实测无风险。

### D. 浮动 Promise 检查结果：**无**

对 `index.js` grep `void ` 与 `.then(`：0 处。所有 async 调用点都有 `await` 且在 try/catch 内。`client.js` 有两处 `.then(`，均为 React 组件内且各自带 `.catch(...)`。

---

## 6. 补丁建议（P0/P1 已实施，P2/P3 未做）

| 优先级 | 改动 | 目的 | 状态 |
|---|---|---|---|
| **P0** | 加固 §5-A：`sendJson` 自身 try/catch（并检查 `headersSent` / `writableEnded`）；三条路由统一套 `guardHandler` 最外层兜底 | 消除"客户端断开 → Host 退出"的路径 | ✅ 已实施 |
| **P0** | 加固 §5-B：`archivedSessionIds` 改为手动 `next()` 取一帧 + 安全收尾（先 `return()`，再清定时器，最后 abort，每步 catch） | 消除 async generator + abort 的未消费拒绝 | ✅ 已实施 |
| **P1** | 冷启动静默期 `COLD_START_QUIET_MS = 90_000`：这段时间内跳过 `tokensToday` | 让 Host 启动/握手窗口里没有重活 | ✅ 已实施 |
| **P2** | 增加诊断开关（如 `DSH_TICK_DEBUG=1`）输出调用参数与返回结构 | 复现时能定位 | ⬜ 未做 |
| **P3** | 可选：插件内注册 `unhandledRejection` 监听，**只记日志不阻断** | 下次崩溃留下堆栈 | ⬜ 未做（黑匣子已覆盖） |

### 实施后的验证（2026-11-17 11:29Z）

```
11:29:50.662 已注册 6 个工具 / 已加载
11:29:53.675 [info] 冷启动 3 秒内跳过 token 统计，避免占用启动/握手窗口   ← P1 生效
         GET /config    ok=true  预算 3 亿 / 已用 11,427,880            ← P0-A 路径
         GET /jobs      ok=true  任务 0
         GET /sessions  ok=true  可见 4 / 归档 10                        ← P0-B 路径
         POST 非法时间  HTTP 400 + 可读错误                               ← 错误路径仍正常
         重载后 warn/error 行数：0
```

### P1 的代价（需要知情）

冷启动后 **90 秒内不刷新 token 用量**，这段时间预算闸用的是上次持久化的值。取舍：3 亿的额度下这点偏差无实际影响，而换来的是启动窗口内没有 5–9 秒的重活。

### P3 的注意

同时注册多个 `unhandledRejection` 监听器不会阻止 DSH 的处理器执行，所以**不能**靠它阻止退出，只能留证据。

---

## 7. 验证方案（零改动的 A/B）

插件已有**总开关**（设置页「启用 DSH-Tick」），关闭后：

- `scan()` 仍写心跳，但**不调用 `tokensToday`、不认领任何任务**；
- 因此 P1 想规避的那块重活完全不执行。

实验步骤：

1. 重启电脑，开机后 2–5 分钟内首次启动 DSH；
2. 立刻打开 设置 → DSH-Tick，**关闭总开关**；
3. 观察 5 分钟。

判定矩阵：

| 观察结果 | 结论 |
|---|---|
| 仍然崩 | tick 排除嫌疑，转查其他插件（见 §8 的 qqbot 线索） |
| 不再崩 | tick 的冷启动扫描确为诱因或放大器，执行 P0+P1 |

> 注意：关闭总开关后 tick 仍会加载、仍注册工具与路由，只是不触发。这正好把"加载"与"扫描"两个变量分离开。

---

## 8. 下次抓证据的方法

当前**没有 Host stderr 的落点**，这是排查最大的障碍：

- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 只有 `crash-*-main.log`，内容固定为 `fetch failed / ECONNRESET`，来自主进程；
- Host 的 stderr 由主进程持有，主进程先崩 → 缓冲区丢失；
- 黑匣子 `diag-unhandled.log` 首次记录为 `2026-11-17T10:32:29Z`（本地 18:32），**覆盖不到 18:05 的两次崩溃**。

建议：

1. 确认黑匣子插件在 profiling 里处于启用状态，并在下次开机后先确认它有 `[hb]` 心跳；
2. 若能给 Host 的 spawn 加 `stdio` 落盘（需改 DSH 本体或 Electron 启动参数），是最直接的证据来源。

### 另一条线索

`qqbot-bridge-diag.log` 的最后一条：

```
[2026-11-16T10:24:03.660Z] bridge apply 被调用 inject=["settings","webServer"] …
```

而崩溃 #1 是 `2026-11-16T10:24:09.903Z` —— **该插件 apply 后 6.2 秒崩溃**。这条线索原文档未提及，值得单独核查。

---

## 9. 待验证的假设（按可信度排序）

| # | 假设 | 支持证据 | 反证/不确定 |
|---|---|---|---|
| H-A | 某个插件的 `apply` 期异步异常导致 Host exit(1) | DSH 对 unhandledRejection 直接 exit(1)；崩溃时无 Host stderr | 缺堆栈 |
| H-B | tick 的冷启动 `tokensToday` 占住启动窗口，导致握手被重置 | 崩溃 #4 恰好卡在该函数内 9 秒；#5 主进程判失败时 Host 仍在跑 | 崩溃 #2/#3 时 tick 已停用 |
| H-C | tick 停用不彻底（有残留计时器） | — | 停用后 journal 显示 `applied`，且崩溃前 167 秒无运行迹象 |
| H-D | 与开机后首次启动的系统级因素有关（磁盘/驱动/安全软件） | 只复现于冷启动；安全模式不崩 | 安全模式同时也去掉了所有插件，变量未分离 |

---

## 附录：本次排查用到的关键路径

| 文件 | 用途 |
|---|---|
| `C:\Users\<user>\.dsh\dsh-tick-data\tick.log` | tick 日志（**UTC**） |
| `C:\Users\<user>\.dsh\diag-unhandled.log` | 黑匣子（覆盖 11-17 18:32 之后） |
| `C:\Users\<user>\.dsh\qqbot-bridge-diag.log` | qqbot 桥接诊断 |
| `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-main.log` | 主进程崩溃日志 |
| `%APPDATA%\@deepseek-ai\dsh-desktop\plugin-operations\` | 插件启用/停用 journal（§1 证据来源） |
| `<目录>\dsh-tick\index.js` | 被排查的插件代码 |
