// DSH-Tick · Host 半（最小可跑版）
//
// 目标：跑通「模型建任务 → 到点 → 过闸 → 唤醒会话」这一条链路。
// 工具面目前只有 tick_once，其余 5 个工具与设置页在后续提交补。
//
// 与设计稿的对应：
//   §4  TickJob 模型        → src/jobs.js
//   §5  服务契约（部分）     → 本文件的 tickOnce
//   §6  恢复与补偿           → src/recovery.js（本阶段只用 nextAfterFire）
//   §10 工具面（1/6）        → tickOnce
//   §10.3 注入模板          → renderTrigger

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { systemClock } from './src/clock.js'
import { emptyState, evaluateGate, recordRun, rollDay } from './src/gate.js'
import { createJobsService } from './src/jobs.js'
import { classifyScan, decideMissed, expiredUnreachable, nextAfterFire, pushMissed } from './src/recovery.js'
import { sumTodayTokens } from './src/tokens.js'
import { dayKey, minutesOfDay, parseClockTime, withinWindow, zonedParts } from './src/timezone.js'
import { DEFAULTS, loadSettings, saveSettings, validatePatch } from './src/config.js'
import { lateToleranceMinutes, resolveGate } from './src/settings.js'
import { DEFAULT_GRACE_MS } from './src/recovery.js'
import { openStore } from './src/store.js'
import { describeCadence } from './src/cadence.js'

export const name = 'tick'

// 只硬依赖 tools；sessionController 用 ctx.get 可选取，缺席时任务仍可创建，
// 只是到点无法唤醒（会记日志），不至于让整个插件失活。
export const inject = ['tools']

const SCAN_INTERVAL_MS = 15_000
const TIME_ZONE = 'Asia/Shanghai'

/**
 * 世代编号（挂 globalThis，跨模块重载仍然有效）。
 *
 * 为什么需要它：插件重载会 dispose 旧的 apply，但**已经在跑的异步不会立刻停**——
 * 比如某个任务正在等空闲，dispose 后它仍会跑到落地阶段。旧实例握着旧 store，
 * 它的内存快照里还有"刚被用户删掉的任务"，一写盘就把任务复活了。
 * 落地阶段写盘前用它确认自己还是当前这一代，不是就放弃写入。
 */
const GENERATION_KEY = Symbol.for('dsh-tick.generation')

function nextGeneration() {
  const next = (globalThis[GENERATION_KEY] ?? 0) + 1
  globalThis[GENERATION_KEY] = next
  return next
}

function isCurrentGeneration(generation) {
  return globalThis[GENERATION_KEY] === generation
}
/** 单次唤醒的 aborted 超时。 */
const WAKE_TIMEOUT_MS = 15_000
/** 唤醒失败后，同一任务的重试退避。 */
const FAILURE_BACKOFF_MS = 5 * 60_000
/** 冷启动静默期：这段时间内不做 token 统计（翻会话日志是启动窗口里唯一的重活）。 */
const COLD_START_QUIET_MS = 90_000
/** 不可达任务保留多久供改绑；过期自动移除并在「错过的提醒」留档。 */
const UNREACHABLE_TTL_MS = 24 * 60 * 60_000

function iso(ms) {
  return new Date(ms).toISOString()
}

/**
 * 正常触发模板（英文，与官方 goal / todo / schedule 的注入风格一致）。
 * @param {object} job
 * @param {number} now
 */
function renderTrigger(job, now) {
  const lateMin = Math.max(0, Math.floor((now - job.nextDueAt) / 60_000))
  const lines = [
    `[Timer] ${job.id}`,
    `You scheduled this task at ${iso(job.createdAt)}.`,
    `Task: ${job.scratch}`,
    `Scheduled: ${iso(job.nextDueAt)}`,
  ]
  if (lateMin > 0) lines.push(`Fired: ${iso(now)}, ${lateMin} min late`)
  lines.push('-- Act on the task above. If it is no longer meaningful, end the turn without replying.')
  return lines.join('\n')
}

/**
 * 多条错过合并成一条告知（F14）。
 *
 * 同一轮扫描里可能有好几条一起过期；逐条唤醒会让用户连收多条、连跑多轮 turn。
 * 这里合成一条，按"原定时间"排序后逐行列出。
 */
function renderMissedMany(items, now) {
  if (items.length === 1) {
    const [item] = items
    return renderMissed({ ...item, nextDueAt: item.dueAt, createdAt: item.dueAt }, now)
  }
  const sorted = [...items].sort((a, b) => a.dueAt - b.dueAt)
  const lines = [
    `[Timer] ${sorted.length} missed tasks`,
    '-- These reminders are already overdue; they are not something to do now.',
    '   Mention them if they still matter, otherwise end the turn.',
    '',
  ]
  for (const item of sorted) {
    const lateMin = Math.max(0, Math.floor((now - item.dueAt) / 60_000))
    lines.push(`- ${item.id} | scheduled ${iso(item.dueAt)} (~${lateMin} min late): ${item.scratch}`)
  }
  return lines.join('\n')
}

/** 错过告知模板（§6.4 / §10.3）。 */
function renderMissed(job, now) {
  const lateMin = Math.max(0, Math.floor((now - job.nextDueAt) / 60_000))
  return [
    `[Timer] Missed task ${job.id}`,
    `Scheduled: ${iso(job.nextDueAt)}`,
    `Missed by: ~${lateMin} min`,
    `Task: ${job.scratch}`,
    '-- This reminder is already overdue; it is not something to do now.',
    '   Mention it if it still matters, otherwise end the turn.',
  ].join('\n')
}

export function apply(ctx, config = {}) {
  const clock = systemClock()
  // 本代编号：重载后旧实例的落地阶段会因此放弃写入（见 GENERATION_KEY 的说明）
  const generation = nextGeneration()

  // 配置放在插件自己的数据目录（本地 link 安装解析不到 schemastery，故不用宿主 Config）。
  const DATA_DIR =
    typeof config?.dataDir === 'string' && config.dataDir
      ? config.dataDir
      : process.env.DSH_TICK_DATA_DIR || join(homedir(), '.dsh', 'dsh-tick-data')

  const loaded = loadSettings(DATA_DIR)
  let settings = loaded.settings

  // 这些值都**现算**，所以设置页保存后立刻生效，不需要重启插件。
  const currentPolicy = () => ({ window: { start: settings.windowStart, end: settings.windowEnd } })
  const currentGates = () => ({
    maxRunsPerDay: settings.maxRunsPerDay,
    budgetDailyTokens: settings.budgetDailyTokens,
  })
  // 任务服务在创建时捕获 global，所以这里用 getter 视图而不是快照：
  // 改配置后限额立刻生效，且**不需要重建 store**。
  // （曾经的做法是保存配置时 booted=null 重建 store，结果同一 jobs.json
  //   出现两个实例，老实例刚删掉的任务会被新实例的内存快照"复活"并再次触发。）
  const jobGlobalView = {
    get maxJobs() {
      return settings.maxJobs
    },
    get maxImportantJobs() {
      return settings.maxImportantJobs
    },
    get allowModelCreate() {
      return settings.allowModelCreate !== false
    },
    get minIntervalMin() {
      return settings.minIntervalMin
    },
    get maxScratchChars() {
      return settings.maxScratchChars
    },
  }

  let state = emptyState()
  let booted = null
  const inFlight = new Set()

  const log = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${message}`
    try {
      const dir = dataDir()
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'tick.log'), `${line}\n`)
    } catch {
      // 日志失败不能影响主流程
    }
    try {
      ctx.logger?.[level]?.(`[tick] ${message}`)
    } catch {
      // 同上
    }
  }

  function dataDir() {
    return DATA_DIR
  }

  // 配置文件坏了/有未知键时，loadSettings 会静默回落到出厂默认——
  // 那等于把所有设置悄悄重置。必须留下痕迹，否则用户只会觉得"设置全没了"。
  if (loaded.warning) log('warn', `${loaded.warning}（本次已回落到出厂默认；原文件未改动，可自行修正后重启）`)

  /** 懒初始化：apply 同步返回，存储与业务服务在首次使用时装配。 */
  function ensure() {
    booted ??= (async () => {
      const store = await openStore({ dir: dataDir() })
      const jobs = createJobsService({ store, clock, global: jobGlobalView })
      // 恢复当日计数：不落盘的话，重启一次每日次数上限就被绕过了
      if (store.meta.gateState && typeof store.meta.gateState === 'object') {
        state = rollDay({ ...emptyState(), ...store.meta.gateState }, clock.now(), TIME_ZONE)
      }
      return { store, jobs }
    })()
    return booted
  }

  /**
   * 唤醒目标会话。
   *
   * 只用官方 `sessionController.prompt(request, signal)`：
   * 签名来自运行时 Service 契约（`prompt(request: SessionPromptRequest, signal: AbortSignal)`），
   * 不是猜的。会话未打开时由宿主先 resume，再投递。
   *
   * **绝不做 fallback**：上一版在这里 fallback 到 `agent.inject(裸字符串)`，
   * 直接把非法结构写进 `agent/inbox/spliced`，导致会话读不出来。
   * 现在失败就抛错、由上层退避，宁可不唤醒也不写坏数据。
   */
  async function wake(sessionId, text) {
    const sessionController = ctx.get('sessionController')
    if (typeof sessionController?.prompt !== 'function') {
      throw new Error('sessionController.prompt 不可用')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WAKE_TIMEOUT_MS)
    try {
      await sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: TIME_ZONE,
        },
        controller.signal,
      )
      log('info', `prompt 成功 → ${sessionId}`)
    } catch (error) {
      // 会话被删/找不到时，重试再多次也没用——标记出来让上层置 unreachable。
      const message = String(error?.message ?? error)
      if (/not[-_ ]?found|unknown session|ENOENT/i.test(message)) {
        const tagged = new Error(`目标会话不可达：${message}`)
        tagged.code = 'session-not-found'
        throw tagged
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  // ── 归档会话 ───────────────────────────────────────────────────────────
  //
  // `sessionController.list` 返回的是全部会话，**不排除已归档的**（实测）。
  // 归档集合的唯一来源是 `workspaceController.follow()` 的 baseline 帧：
  //   WorkspaceBaseline { items, archivedSessionIds, pinnedSessionIds }
  // 这里订阅一次、取到 baseline 就断开，缓存 30 秒（设置页打开频率很低）。
  let archivedCache = { at: 0, ids: new Set() }
  const ARCHIVE_CACHE_MS = 30_000

  async function archivedSessionIds() {
    const now = clock.now()
    if (now - archivedCache.at < ARCHIVE_CACHE_MS) return archivedCache.ids

    const workspaceController = ctx.get('workspaceController')
    if (typeof workspaceController?.follow !== 'function') return archivedCache.ids

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    let iterator
    try {
      // 手动迭代，只取 baseline 一帧。
      // 不用 for await：从它里面 return 会先调 iterator.return()，紧随其后的 abort
      // 可能让流内部挂起的 promise 拒绝而无人接管 → unhandledRejection → Host exit(1)。
      iterator = workspaceController.follow(controller.signal)[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first?.done) return archivedCache.ids
      const frame = first.value
      if (frame?.type !== 'baseline') return archivedCache.ids
      const ids = new Set((frame.value?.archivedSessionIds ?? []).map(String))
      archivedCache = { at: now, ids }
      return ids
    } catch (error) {
      log('warn', `读取归档集合失败（沿用上次结果）：${error?.message ?? error}`)
      return archivedCache.ids
    } finally {
      // 收尾顺序：先让迭代器真正结束，再清定时器，最后 abort。
      // 每一步都不能让拒绝逃逸；若 return() 卡住，3 秒的定时器会 abort 来解开。
      try {
        await iterator?.return?.()
      } catch {
        // 迭代器收尾失败不影响已取得的结果
      }
      clearTimeout(timer)
      try {
        controller.abort()
      } catch {
        // abort 本身不应抛
      }
    }
  }

  // ── 会话 token 统计 ─────────────────────────────────────────────────────
  //
  // 口径：**单会话、当日累计**。数据来自会话日志里 assistant/message 的 usage。
  // DSH 不提供 API 账户级花费，所以这里回答的是"这个会话今天用了多少 token"。
  // 结果缓存 5 分钟：预算不需要秒级精度，避免每轮扫描都翻一遍日志。
  // 每个会话一个缓存槽位：预算按会话各自独立，切换会话时互不影响。
  const tokenCache = new Map() // sessionId -> { at, tokens }
  const TOKEN_CACHE_MS = 5 * 60_000
  const TOKEN_PAGE = 200
  // 200 页 × 200 = 最多 40000 条事件。会话热时 50 页只要 7ms，所以放宽的代价很小；
  // 真翻不满仍会明确告警（不会假装完整）。
  const TOKEN_MAX_PAGES = 200

  /** 指定时区下「今天 00:00」的时间戳。 */
  function startOfDayMs(now, timeZone) {
    const p = zonedParts(now, timeZone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    const offset = asUtc - now // 该时区相对 UTC 的偏移
    return Date.UTC(p.year, p.month - 1, p.day) - offset
  }

  async function tokensToday(sessionId) {
    const now = clock.now()
    const day = dayKey(now, TIME_ZONE)
    const cached = tokenCache.get(sessionId)
    // 缓存必须同时匹配日期：否则 23:58 算出的值会在 00:01 被当成"今天"的量
    if (cached && cached.day === day && now - cached.at < TOKEN_CACHE_MS) return cached.tokens

    const sessionController = ctx.get('sessionController')
    if (typeof sessionController?.events !== 'function') return cached?.tokens ?? 0

    const start = startOfDayMs(now, TIME_ZONE)
    const previous = cached?.tokens ?? null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const result = await sumTodayTokens({
        startOfDay: start,
        pageSize: TOKEN_PAGE,
        maxPages: TOKEN_MAX_PAGES,
        fetchPage: (request) =>
          sessionController.events(
            { address: { kind: 'session', sessionId }, ...request },
            controller.signal,
          ),
      })

      tokenCache.set(sessionId, { at: now, day, tokens: result.total })

      if (!result.complete) {
        // 不许静默：这种情况下 total 只是下界，预算可能因此漏拦
        log(
          'warn',
          `token 统计不完整（${sessionId}）：翻了 ${result.pages} 页仍未到达今日 0 点，已用值 ${result.total.toLocaleString()} 只是下界`,
        )
      } else if (previous !== result.total) {
        log('info', `今日 token 累计（${sessionId}）：${result.total.toLocaleString()}`)
      }
      return result.total
    } catch (error) {
      log('warn', `token 统计失败（沿用上次值）：${error?.message ?? error}`)
      return cached?.tokens ?? 0
    } finally {
      clearTimeout(timer)
    }
  }

  let switchedOffLogged = false
  // 心跳（lastScanAt）上次落盘的时刻，用于节流；见 scan 里的说明。
  let lastScanWriteAt = 0
  // 定时器重建入口：保存配置后调用，让扫描间隔立即生效（见下方 ctx.effect）。
  let restartScanTimer = () => {}
  // 冷启动静默期起点：apply 完成时刻。见 scan 里对 token 统计的说明。
  const bootAt = clock.now()
  let coldStartSkipLogged = false

  /**
   * 某个会话「今天的 token 用量」，用作该会话的预算输入。
   *
   * 冷启动静默期内直接返回 0（等于不拦）：翻会话日志是本插件唯一的重活，
   * 而它恰好压在 Host 启动与主进程握手的窗口里。
   */
  async function spentFor(sessionId) {
    if (!sessionId) return 0
    if (clock.now() - bootAt < COLD_START_QUIET_MS) {
      if (!coldStartSkipLogged) {
        log('info', `冷启动 ${Math.round((clock.now() - bootAt) / 1000)} 秒内跳过 token 统计，避免占用启动/握手窗口`)
        coldStartSkipLogged = true
      }
      return 0
    }
    return tokensToday(sessionId)
  }


  async function scan() {
    const { store, jobs } = await ensure()
    // 目标会话：设置页新建任务时要用。优先用显式记录，其次从已有任务回填。
    if (!store.meta.lastSessionId) {
      const known = store.listJobs()[0]
      if (known?.boundSessionId) await store.setMeta({ lastSessionId: known.boundSessionId })
    }
    const now = clock.now()
    state = rollDay(state, now, TIME_ZONE)

    // 自检环：睡眠/挂起会让墙钟跳变，和扫描节奏对不上。这里只负责识别与告警，
    // 真正的补偿由 decideMissed 按 lateTolerance 处理（v1.8 起的语义）。
    const scanMs = Math.max(100, Math.round(settings.scanIntervalMin * 60) * 1000)
    const scanned = classifyScan({
      now,
      lastScanAt: store.meta.lastScanAt ?? 0,
      scanIntervalMs: scanMs,
      // 间隔可以小到 6 秒，若仍按「3 倍间隔」判挂起就只有 18 秒，太敏感
      //（一次 GC 停顿就可能误判）。这里给检测窗口加 60 秒下限。
      factor: Math.max(settings.suspendDetectFactor, Math.ceil(60_000 / scanMs)),
    })
    if (scanned.kind === 'suspended') {
      log('warn', `检测到长时间挂起：距上次扫描约 ${Math.round(scanned.delta / 60_000)} 分钟，本轮按补偿处理`)
    } else if (scanned.kind === 'clock-back') {
      log('warn', `检测到时钟倒退约 ${Math.round(-scanned.delta / 1000)} 秒，计数按新日期重算`)
    }
    // 心跳写入节流：间隔可以调到 6 秒，每拍都写盘没必要。
    // 5 秒的粒度对"判断是否挂起"完全够用（检测窗口本身有 60 秒下限）。
    if (now - lastScanWriteAt >= 5000) {
      await store.setMeta({ lastScanAt: now })
      lastScanWriteAt = now
    }

    // 总开关：关闭时照常写心跳（否则重新开启会被自检环误判成挂起），
    // 但不刷新 token、不认领任何任务——任务原样保留，打开后继续。
    if (settings.enabled === false) {
      if (!switchedOffLogged) {
        log('info', '总开关已关闭，暂停所有触发（任务保留）')
        switchedOffLogged = true
      }
      return
    }
    if (switchedOffLogged) {
      log('info', '总开关已开启，恢复扫描')
      switchedOffLogged = false
    }

    // 预算不再在这里算：每个任务按**自己所属会话**的当日用量判定（见下方评估阶段）。

    // 僵尸任务清理：不可达超过 TTL 就移除，并在「错过的提醒」留档。
    // 留着只会占名额、让 tick_list 看起来正常却永远不触发。
    for (const job of expiredUnreachable(jobs.list({ detail: true }), now, UNREACHABLE_TTL_MS)) {
      const missed = pushMissed(
        store.meta.missed ?? [],
        { id: job.id, scratch: job.scratch, dueAt: job.nextDueAt, lateMin: 0, dropReason: 'unreachable' },
        settings.missedMax,
      )
      await store.setMeta({ missed })
      await store.removeJob(job.id)
      log('warn', `${job.id} 目标会话长期不可达，已自动移除（记录已留在「错过的提醒」）`)
    }

    // 认领到期任务。inFlight 覆盖「评估 + 落地」整个生命周期，
    // 这样下一轮扫描（15 秒后）不会重复认领仍在等空闲的任务。
    const claims = []
    for (const job of jobs.list({ detail: true })) {
      if (job.nextDueAt > now) continue
      // 失败退避：唤醒失败过的任务在 5 分钟内不再重试，避免每 15 秒刷一次
      if (job.lastErrorAt && now - job.lastErrorAt < FAILURE_BACKOFF_MS) continue
      if (inFlight.has(job.id)) continue
      inFlight.add(job.id)
      claims.push(job)
    }
    if (claims.length === 0) return

    try {
      // ① 并发评估：每个任务的等空闲互不阻塞（旧版是串行 for，一个等 5 分钟会挡住后面所有任务）
      const evaluations = await Promise.all(
        claims.map(async (job) => {
          try {
            log('info', `评估 ${job.id}`)
            const decision = decideMissed(job, {
              now,
              lateToleranceMin: lateToleranceMinutes(job.cadence.type, job.importance, {
                global: { lateToleranceOnceMin: settings.lateToleranceOnceMin },
              }),
              // 周期任务的宽限：扫描间隔 + 10 秒。
              // 到期时刻落在两次扫描之间属于正常，不能算错过（否则永远不触发）。
              graceMs: Math.max(DEFAULT_GRACE_MS, settings.scanIntervalMin * 60_000 + 10_000),
            })
            if (
              decision.action === 'drop' ||
              decision.action === 'miss' ||
              // 顺延不需要过闸：它本来就不会唤醒，没必要等空闲/查预算
              decision.action === 'reschedule'
            ) {
              return { job, decision }
            }

            // 预算按【该任务所属会话】的当日用量判定。
            // 每个会话各自独立：给 A 建/删任务，不会影响 B 的判定；
            // 没有任务的会话根本不会走到这里，也就不会被"加锁"。
            const spentTokens = await spentFor(job.boundSessionId)

            // 闸是纯同步判定：没有"等空闲"阶段（prompt 用 queue 模式，宿主自己排队）
            const gate = evaluateGate(job, {
              now,
              timeZone: TIME_ZONE,
              policy: currentPolicy(),
              gates: currentGates(),
              state: { ...state, spentTokens },
              // 单任务每日上限：此前 jobDefaults 没传，这个闸等于没生效
              jobDefaults: { maxPerDay: settings.maxPerDay },
            })
            return { job, decision, gate }
          } catch (error) {
            return { job, error: String(error?.message ?? error) }
          }
        }),
      )

      // ② 串行落地：写盘与唤醒都不并发——store 是整文件原子写，并发会互相覆盖
      // 本轮要发的补告知，按会话攒起来，循环结束后每个会话只唤醒一次
      const noticesBySession = new Map()
      for (const item of evaluations) {
        const { job } = item
        // 本代已被取代（插件重载了）：立刻停手，绝不能用旧 store 的快照写盘
        if (!isCurrentGeneration(generation)) {
          log('info', '插件已重载，放弃本轮落地写入（防止旧快照复活已删除的任务）')
          break
        }
        try {
          if (item.error) {
            log('warn', `${job.id} 处理失败：${item.error}`)
            await store.updateJob(job.id, { lastErrorAt: now, lastError: item.error })
            continue
          }

          const { decision, gate } = item
          if (decision.action === 'drop') {
            log('info', `${job.id} 错过且超过容忍，丢弃`)
            await store.removeJob(job.id)
            continue
          }
          if (decision.action === 'reschedule') {
            // 周期任务错过的那一轮直接丢掉、顺延到下一次，**不补跑**。
            // 这条分支以前漏了，于是系统休眠醒来后每个过期的周期任务都会立刻触发一次
            //（5 个任务就是连发 5 次唤醒），与设计稿 v1.8 语义相反。
            log('info', `${job.id} 错过一轮（迟到 ${decision.lateMin} 分钟），顺延到下一次`)
            await reschedule(job, now, store)
            continue
          }
          if (decision.action === 'miss') {
            // 落盘到 missed：任务随后会被删掉，不记下来 UI 就再也看不到了
            const missed = pushMissed(
              store.meta.missed ?? [],
              {
                id: job.id,
                scratch: job.scratch,
                dueAt: job.nextDueAt,
                lateMin: decision.lateMin,
              },
              settings.missedMax,
            )
            await store.setMeta({ missed })
            await store.removeJob(job.id)
            // 先攒着，别一条一条唤醒——同一轮里 3 条错过只该吵醒一次
            const bucket = noticesBySession.get(job.boundSessionId) ?? []
            bucket.push({ id: job.id, scratch: job.scratch, dueAt: job.nextDueAt })
            noticesBySession.set(job.boundSessionId, bucket)
            continue
          }

          if (!gate.pass) {
            log('info', `${job.id} 被硬门拦下：${gate.reason} — ${gate.detail}`)
            if (job.cadence.type !== 'once') {
              await reschedule(job, now, store)
            }
            continue
          }

          // 评估是同步的、不会长时间阻塞，但仍复查一次：
          // 极端情况下（同一轮里被前面的落地删掉）不该再唤醒。
          if (!store.getJob(job.id)) {
            log('info', `${job.id} 等待期间已被删除，跳过本次唤醒`)
            continue
          }

          await wake(job.boundSessionId, renderTrigger(job, now))
          state = recordRun(state, job.id)
          // 计数落盘：否则重启后 ranToday 归零，每日次数上限形同虚设
          await store.setMeta({ gateState: state })
          await store.appendRun({ id: job.id, dueAt: job.nextDueAt, firedAt: now, action: 'fire' })
          log('info', `${job.id} 已唤醒会话 ${job.boundSessionId}`)
          await reschedule(job, now, store)
        } catch (error) {
          const reason = String(error?.message ?? error)
          if (error?.code === 'session-not-found') {
            // 目标会话没了：继续重试没有意义，标记不可达交由闸拦下并提示用户改绑
            log('warn', `${job.id} 目标会话不可达，任务已挂起（可在设置页改绑会话）`)
            await store.updateJob(job.id, {
              unreachable: true,
              // 记录"第一次不可达"的时刻，TTL 从它算起（重复失败不刷新）
              unreachableSince: job.unreachableSince ?? now,
              lastErrorAt: now,
              lastError: reason,
            })
            continue
          }
          log('warn', `${job.id} 落地失败：${reason}`)
          await store.updateJob(job.id, { lastErrorAt: now, lastError: reason })
        }
      }

      // ③ 补告知：每个会话只唤醒一次，把本轮所有错过合成一条
      if (!isCurrentGeneration(generation)) {
        log('info', '插件已重载，跳过本轮补告知')
        return
      }
      for (const [sessionId, items] of noticesBySession) {
        try {
          await wake(sessionId, renderMissedMany(items, now))
          for (const item of items) {
            await store.appendRun({ id: item.id, dueAt: item.dueAt, firedAt: now, action: 'missed-notice' })
          }
          log('info', `已补告知 ${items.length} 条过期提醒 → ${sessionId}`)
        } catch (error) {
          log('warn', `补告知失败（${items.length} 条，${sessionId}）：${error?.message ?? error}`)
        }
      }
    } finally {
      for (const job of claims) inFlight.delete(job.id)
    }
  }

  async function reschedule(job, fromMs, store) {
    if (job.cadence.type === 'once') {
      await store.removeJob(job.id)
      return
    }
    const next = nextAfterFire(job, { firedAt: fromMs })
    const updated = await store.updateJob(job.id, { lastFiredAt: fromMs, nextDueAt: next })
    if (!updated) log('info', `${job.id} 等待期间已被删除，不再重排`)
  }

  // ── 共用 ────────────────────────────────────────────────────────────────

  const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      id: { type: 'string' },
      at: { type: 'number' },
      atLocal: { type: 'string' },
      atUTC: { type: 'string' },
      summary: { type: 'string' },
      jobs: { type: 'array', items: { type: 'object' } },
      code: { type: 'string' },
      hint: { type: 'string' },
    },
  }

  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

  function createdResult(job) {
    // H9：周期任务的首个到期点若落在活跃窗口外，它不会立刻跑（会被窗口闸拦下并顺延）。
    // 一次性任务不受窗口限制，所以只有周期任务需要提示。
    const window = currentPolicy().window
    const outsideWindow =
      job.cadence.type !== 'once' &&
      !withinWindow(
        minutesOfDay(job.nextDueAt, TIME_ZONE),
        parseClockTime(window.start),
        parseClockTime(window.end),
      )
    return {
      ok: true,
      id: job.id,
      at: job.nextDueAt,
      atLocal: new Date(job.nextDueAt).toISOString(),
      atUTC: new Date(job.nextDueAt).toISOString(),
      summary: `将在 ${iso(job.nextDueAt)} 触发（${describeCadence(job.cadence)}）${
        outsideWindow ? ' · 注意：这个时刻在活跃窗口外，会顺延到窗口内才触发' : ''
      }`,
      ...(outsideWindow ? { outsideWindow: true } : {}),
    }
  }

  /** 只能操作绑在自己身上的任务。 */
  function ownedOrError(job, sessionId) {
    if (!job) return { ok: false, code: 'not_found', hint: '找不到该任务' }
    if (job.boundSessionId !== sessionId) {
      return { ok: false, code: 'not_yours', hint: '这个任务绑定在别的会话上，不能在这里操作' }
    }
    return null
  }

  /**
   * 子代理拦截（A 方案）。
   *
   * 工具是全局注册的，子代理也能调。但子代理创建的定时任务会：
   *   ① 绑到子代理自己的会话——到点唤醒一个没人看的会话，白烧 token；
   *   ② 覆盖 meta.lastSessionId，把 token 统计口径和设置页的目标会话都改掉；
   *   ③ 占用全局任务名额，而主会话的 tick_list 看不到它们。
   * 所以创建类工具在非根会话上一律拒绝。
   */
  function subagentDenied(exec) {
    const agent = exec?.agent
    if (!agent?.id) return null
    const subagents = ctx.get('subagents')
    if (typeof subagents?.rootOf !== 'function') return null // 没有该服务就不拦，避免误伤
    try {
      const root = subagents.rootOf(agent)
      if (!root?.id || root.id === agent.id) return null
      log('info', `拒绝子代理 ${agent.id} 创建任务（根会话 ${root.id}）`)
      return {
        ok: false,
        code: 'subagent_denied',
        hint: '定时任务只能由主会话创建：子代理生命周期短，任务醒来也没人看。请让主会话来排。',
      }
    } catch {
      return null
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────

  const tickOnce = {
    name: 'tick_once',
    description:
      'Schedule a one-shot reminder for this session. Give either inMinutes (relative) or at (ISO 8601 with timezone offset). When it fires, this session is woken with your scratch note. Calendar-style repeats (daily/weekly) are not supported here — use schedule_create for those.',
    parameters: {
      type: 'object',
      properties: {
        inMinutes: {
          type: 'integer',
          minimum: 1,
          maximum: 43200,
          description: 'Minutes from now (relative). Mutually exclusive with at.',
        },
        at: {
          type: 'string',
          description:
            'Absolute time as ISO 8601 WITH offset, e.g. "2026-11-17T06:00:00+08:00". Bare timestamps are rejected.',
        },
        scratch: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'A note to your future self describing what to do when this fires.',
        },
        importance: {
          type: 'string',
          enum: ['normal', 'important'],
          description: 'important keeps a missed notice after the tolerance window.',
        },
      },
      required: ['scratch'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const { jobs, store } = await ensure()
      const denied = subagentDenied(exec)
      if (denied) return denied
      const cadence = { type: 'once' }
      if (args?.inMinutes !== undefined) cadence.inMinutes = args.inMinutes
      if (args?.at !== undefined) cadence.at = args.at

      const result = await jobs.create(
        { cadence, scratch: args?.scratch, importance: args?.importance },
        { origin: 'model', boundSessionId: exec?.agent?.id },
      )
      if (!result.ok) return { ok: false, code: result.code, hint: result.hint }
      // 记住目标会话：设置页新建任务时需要绑定到同一个会话
      if (exec?.agent?.id) await store.setMeta({ lastSessionId: exec.agent.id })
      return createdResult(result.job)
    },
  }

  const tickRepeat = {
    name: 'tick_repeat',
    description:
      'Schedule a repeating task for this session. mode=fixed uses everyMinutes; mode=random draws a fresh interval from [minMinutes, maxMinutes] each time. Use it for ambient checks, not for calendar rules (use schedule_create for "every day at 09:00").',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fixed', 'random'] },
        everyMinutes: { type: 'integer', minimum: 1, maximum: 43200, description: 'For mode=fixed.' },
        minMinutes: { type: 'integer', minimum: 1, maximum: 43200, description: 'For mode=random.' },
        maxMinutes: { type: 'integer', minimum: 1, maximum: 43200, description: 'For mode=random.' },
        scratch: { type: 'string', minLength: 1, maxLength: 200 },
        importance: { type: 'string', enum: ['normal', 'important'] },
      },
      required: ['mode', 'scratch'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const { jobs, store } = await ensure()
      const denied = subagentDenied(exec)
      if (denied) return denied
      const cadence =
        args?.mode === 'random'
          ? { type: 'random', minMinutes: args?.minMinutes, maxMinutes: args?.maxMinutes }
          : { type: 'fixed', everyMinutes: args?.everyMinutes }

      const result = await jobs.create(
        { cadence, scratch: args?.scratch, importance: args?.importance },
        { origin: 'model', boundSessionId: exec?.agent?.id },
      )
      if (!result.ok) return { ok: false, code: result.code, hint: result.hint }
      // 记住目标会话：设置页新建任务时需要绑定到同一个会话
      if (exec?.agent?.id) await store.setMeta({ lastSessionId: exec.agent.id })
      return createdResult(result.job)
    },
  }

  /**
   * 精简投影（与 jobs.list 的默认输出同形）。
   *
   * 注意：**不能**把 undefined 写进返回对象——宿主对工具输出做 lossless JSON 校验，
   * 带 undefined 的属性会被判为非法（已踩过）。缺省字段直接不写。
   */
  /** 去掉值为 undefined 的自有属性：工具输出必须是 lossless JSON。 */
  function dropUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  }

  function toLite(job) {
    const out = {
      id: job.id,
      enabled: job.enabled,
      cadence: job.cadence,
      nextDueAt: job.nextDueAt,
      importance: job.importance,
      origin: job.origin,
      unreachable: job.unreachable,
    }
    return out
  }

  const tickList = {
    name: 'tick_list',
    description:
      'List the timer tasks owned by this session. Returns a compact view by default; pass detail=true for the full records including scratch text.',
    parameters: {
      type: 'object',
      properties: { detail: { type: 'boolean' } },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const { jobs } = await ensure()
      const sessionId = exec?.agent?.id
      // 必须用 detail 列表：精简投影里没有 boundSessionId，拿它过滤会永远为空。
      const mine = jobs.list({ detail: true }).filter((job) => job.boundSessionId === sessionId)
      const out = args?.detail === true ? mine.map(dropUndefined) : mine.map(toLite)
      return { ok: true, jobs: out, summary: `本会话共 ${mine.length} 个任务` }
    },
  }

  const tickCancel = {
    name: 'tick_cancel',
    description: 'Cancel one timer task owned by this session. There is no cancel-all; that lives in the admin UI.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const { jobs } = await ensure()
      const job = jobs.list({ detail: true }).find((item) => item.id === args?.id)
      const denied = ownedOrError(job, exec?.agent?.id)
      if (denied) return denied
      const result = await jobs.cancel(args.id)
      if (!result.ok) return { ok: false, code: result.code, hint: result.hint }
      return { ok: true, id: args.id, summary: `已取消 ${args.id}` }
    },
  }

  const tickUpdate = {
    name: 'tick_update',
    description:
      'Update one timer task owned by this session. Any subset of scratch / importance / enabled / cadence fields may be given; omitted fields keep their current value.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scratch: { type: 'string', minLength: 1, maxLength: 200 },
        importance: { type: 'string', enum: ['normal', 'important'] },
        enabled: { type: 'boolean' },
        mode: { type: 'string', enum: ['fixed', 'random'] },
        everyMinutes: { type: 'integer', minimum: 1, maximum: 43200 },
        minMinutes: { type: 'integer', minimum: 1, maximum: 43200 },
        maxMinutes: { type: 'integer', minimum: 1, maximum: 43200 },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const { jobs } = await ensure()
      const job = jobs.list({ detail: true }).find((item) => item.id === args?.id)
      const denied = ownedOrError(job, exec?.agent?.id)
      if (denied) return denied

      const patch = {}
      if (args.scratch !== undefined) patch.scratch = args.scratch
      if (args.importance !== undefined) patch.importance = args.importance
      if (args.enabled !== undefined) patch.enabled = args.enabled
      if (args.mode !== undefined) {
        patch.cadence =
          args.mode === 'random'
            ? { type: 'random', minMinutes: args.minMinutes, maxMinutes: args.maxMinutes }
            : { type: 'fixed', everyMinutes: args.everyMinutes }
      }

      const result = await jobs.update(args.id, patch)
      if (!result.ok) return { ok: false, code: result.code, hint: result.hint }
      return createdResult(result.job)
    },
  }

  const tickRun = {
    name: 'tick_run',
    description:
      'Fire one timer task owned by this session immediately, without waiting for its due time. Counts toward the daily run limit.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const { jobs, store } = await ensure()
      const job = jobs.list({ detail: true }).find((item) => item.id === args?.id)
      const denied = ownedOrError(job, exec?.agent?.id)
      if (denied) return denied

      const now = clock.now()
      try {
        await wake(job.boundSessionId, renderTrigger({ ...job, nextDueAt: now }, now))
      } catch (error) {
        const reason = String(error?.message ?? error)
        log('warn', `手动触发 ${job.id} 失败：${reason}`)
        return { ok: false, code: 'wake_failed', hint: reason }
      }
      state = recordRun(state, job.id)
      await store.setMeta({ gateState: state })
      await store.appendRun({ id: job.id, dueAt: job.nextDueAt, firedAt: now, action: 'manual' })
      log('info', `${job.id} 已手动唤起会话 ${job.boundSessionId}`)
      await reschedule(job, now, store)
      return { ok: true, id: job.id, summary: `已立即执行 ${job.id}` }
    },
  }

  for (const tool of [tickOnce, tickRepeat, tickList, tickCancel, tickUpdate, tickRun]) {
    ctx.effect(() => ctx.tools.register(tool))
  }
  log('info', '已注册 6 个工具')

  // ── 设置页的数据通道 ──────────────────────────────────────────────────
  //
  // Client 用普通 fetch 读写（与 qqbot 的端内设置页同一模式）：
  //   GET  /api/dsh-tick/config → { ok, config }
  //   POST /api/dsh-tick/config → { ok, config } | { ok:false, errors }
  //
  // 写入落在插件自己的 settings.json（原子写），**不碰** profile 的 cordis.patch.yml
  // ——宿主文档明确禁止插件改写那份文件。校验与白名单在服务端做。
  const CONFIG_PATH = '/api/dsh-tick/config'
  const CONFIG_CORS = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }

  /**
   * 写回 JSON 响应。**绝不允许把异常抛出去**：
   * handler 是 async，一旦在 catch 里再抛，就会变成 unhandledRejection，
   * 而 DSH Host 对它的处理是 stderr + exit(1)——Host 静默消失，主进程只看到 ECONNRESET。
   * 客户端提前断开时 writeHead 会抛 ERR_STREAM_DESTROYED，这里必须吞掉。
   */
  function sendJson(res, status, body) {
    try {
      if (res.headersSent || res.writableEnded) return
      const text = JSON.stringify(body)
      res.writeHead(status, CONFIG_CORS)
      res.end(text)
    } catch (error) {
      log('warn', `写回响应失败（客户端可能已断开）：${error?.message ?? error}`)
    }
  }

  /** handler 最外层兜底：任何异常都不许从 HTTP 回调里逃逸。 */
  function guardHandler(handler) {
    return async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        log('warn', `HTTP 处理异常：${error?.message ?? error}`)
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }

  function readJsonBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  function currentConfig() {
    return {
      enabled: settings.enabled !== false,
      windowStart: settings.windowStart,
      windowEnd: settings.windowEnd,
      maxJobs: settings.maxJobs,
      maxImportantJobs: settings.maxImportantJobs,
      allowModelCreate: settings.allowModelCreate !== false,
      maxPerDay: settings.maxPerDay,
      maxRunsPerDay: settings.maxRunsPerDay,
      budgetDailyTokens: settings.budgetDailyTokens,
      minIntervalMin: settings.minIntervalMin,
      maxScratchChars: settings.maxScratchChars,
      lateToleranceOnceMin: settings.lateToleranceOnceMin,
      scanIntervalMin: settings.scanIntervalMin,
      suspendDetectFactor: settings.suspendDetectFactor,
      missedMax: settings.missedMax,
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      log('warn', 'webServer 不可用：设置页将读不到配置')
      return
    }
    scoped.effect(() =>
      webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: guardHandler(async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, {
                ok: true,
                config: currentConfig(),
                // 出厂默认：让前端"重置为默认"有一个唯一权威来源
                defaults: { ...DEFAULTS },
                runtime: {
                  spentTokens: state.spentTokens,
                  ranToday: state.ranToday,
                  budgetDailyTokens: settings.budgetDailyTokens,
                  lastScanAt: (await ensure()).store.meta.lastScanAt ?? 0,
                  missed: (await ensure()).store.meta.missed ?? [],
                },
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
              return
            }

            let patch
            try {
              patch = await readJsonBody(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: error.message })
              return
            }

            const checked = validatePatch(patch)
            if (!checked.ok) {
              sendJson(res, 400, { ok: false, errors: checked.errors })
              return
            }
            if (Object.keys(checked.value).length === 0) {
              sendJson(res, 200, { ok: true, config: currentConfig() })
              return
            }

            // 配置存在插件自己的数据目录里（本地 link 安装无法解析宿主 Config 依赖）。
            // 校验在前，写入原子，内存值立即更新——不需要重启插件。
            const nextSettings = { ...settings, ...checked.value }
            try {
              saveSettings(dataDir(), nextSettings)
            } catch (error) {
              log('warn', `配置写入失败：${error?.message ?? error}`)
              sendJson(res, 500, { ok: false, error: `写入配置失败：${error?.message ?? error}` })
              return
            }

            settings = nextSettings
            // 扫描间隔是定时器参数，改完要重建定时器才生效（其余参数都是每次读取，天然即时）
            restartScanTimer()
            // 不要重置 booted：重建 store 会让同一 jobs.json 出现两个实例，
            // 老实例删掉的任务可能被新实例的内存快照复活并重复触发。
            // 限额通过 jobGlobalView 的 getter 动态读取，无需重建。

            log('info', `配置已更新：${Object.keys(checked.value).join(',')}`)
            sendJson(res, 200, { ok: true, config: currentConfig() })
          } catch (error) {
            log('warn', `配置读写失败：${error?.message ?? error}`)
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }),
      }),
    )
    // ── 任务 CRUD（管理员界面）───────────────────────────────────────────
    //   GET  /api/dsh-tick/jobs → { ok, targetSessionId, jobs }
    //   POST /api/dsh-tick/jobs → { action: 'create' | 'update' | 'delete', ... }
    // 管理员建的任务 origin=admin，绑定到最近一次使用 tick 的会话。
    const JOBS_PATH = '/api/dsh-tick/jobs'
    scoped.effect(() =>
      webServer.register({
        kind: 'exact',
        path: JOBS_PATH,
        handler: guardHandler(async (req, res) => {
          try {
            const { store, jobs } = await ensure()
            const targetSessionId = store.meta.lastSessionId ?? null

            if (req.method === 'GET') {
              sendJson(res, 200, {
                ok: true,
                targetSessionId,
                jobs: jobs.list({ detail: true }),
                stats: jobs.stats(),
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
              return
            }

            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: error.message })
              return
            }

            const fail = (result) =>
              sendJson(res, 400, { ok: false, code: result.code, error: result.hint ?? '操作失败' })

            if (body?.action === 'create') {
              const sessionId =
                typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : targetSessionId
              if (!sessionId) {
                sendJson(res, 400, {
                  ok: false,
                  error: '请先选择一个目标会话（下面那个下拉框）。',
                })
                return
              }
              const result = await jobs.create(
                { cadence: body.cadence, scratch: body.scratch, importance: body.importance },
                { origin: 'admin', boundSessionId: sessionId },
              )
              if (!result.ok) return fail(result)
              await store.setMeta({ lastSessionId: sessionId })
              log('info', `管理员新建任务 ${result.job.id} → 会话 ${sessionId}`)
              sendJson(res, 200, { ok: true, job: result.job, targetSessionId: sessionId })
              return
            }

            if (body?.action === 'update') {
              const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
              const result = await jobs.update(String(body.id ?? ''), patch)
              if (!result.ok) return fail(result)
              log('info', `管理员修改任务 ${body.id}`)
              sendJson(res, 200, { ok: true, job: result.job })
              return
            }

            if (body?.action === 'delete') {
              const result = await jobs.cancel(String(body.id ?? ''))
              if (!result.ok) return fail(result)
              log('info', `管理员删除任务 ${body.id}`)
              sendJson(res, 200, { ok: true })
              return
            }

            if (body?.action === 'rebind') {
              const jobId = String(body.id ?? '')
              const sessionId = String(body.sessionId ?? '')
              if (!sessionId) {
                sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
                return
              }
              const existing = jobs.list({ detail: true }).find((item) => item.id === jobId)
              if (!existing) {
                sendJson(res, 404, { ok: false, error: '任务不存在' })
                return
              }
              const patch = {
                boundSessionId: sessionId,
                unreachable: false,
                lastErrorAt: 0,
                lastError: '',
              }
              if (!(await store.updateJob(jobId, patch))) {
                sendJson(res, 404, { ok: false, error: '任务不存在' })
                return
              }
              await store.setMeta({ lastSessionId: sessionId })
              log('info', `任务 ${jobId} 已改绑到会话 ${sessionId}`)
              sendJson(res, 200, { ok: true, job: { ...existing, ...patch } })
              return
            }

            if (body?.action === 'clearAll') {
              const all = jobs.list({ detail: true })
              for (const item of all) await store.removeJob(item.id)
              log('info', `管理员清空全部任务（${all.length} 个）`)
              sendJson(res, 200, { ok: true, removed: all.length })
              return
            }

            if (body?.action === 'clearMissed') {
              await store.setMeta({ missed: [] })
              log('info', 'missed 列表已清空')
              sendJson(res, 200, { ok: true })
              return
            }

            sendJson(res, 400, {
              ok: false,
              error: '未知 action，可用 create / update / delete / rebind / clearAll / clearMissed',
            })
          } catch (error) {
            log('warn', `任务接口失败：${error?.message ?? error}`)
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }),
      }),
    )

    // ── 会话列表（目标会话选择器）─────────────────────────────────────────
    // 依据运行时契约：sessionController.list(request, signal) → { items: SessionSummary[] }
    // SessionSummary 含 sessionId / cwd / updatedAt / running / agentAvailable / blank。
    const SESSIONS_PATH = '/api/dsh-tick/sessions'
    scoped.effect(() =>
      webServer.register({
        kind: 'exact',
        path: SESSIONS_PATH,
        handler: guardHandler(async (req, res) => {
          try {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: '只支持 GET' })
              return
            }
            const sessionController = ctx.get('sessionController')
            if (typeof sessionController?.list !== 'function') {
              sendJson(res, 503, { ok: false, error: '当前版本没有 sessionController.list' })
              return
            }
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 5000)
            let value
            try {
              value = await sessionController.list({}, controller.signal)
            } finally {
              clearTimeout(timer)
            }
            const items = Array.isArray(value?.items) ? value.items : []
            // 归档会话从工作区分组里隐藏，但 list 仍会返回它们——必须自己过滤
            const archived = await archivedSessionIds()
            let archivedCount = 0
            const sessions = items
              // 空白占位会话与子代理会话不作为目标
              .filter((item) => item && item.blank !== true && item.origin !== 'subagent')
              .filter((item) => {
                if (!archived.has(String(item.sessionId))) return true
                archivedCount += 1
                return false
              })
              .map((item) => {
                // 标题没有独立字段，只能从投影里取。这里按 key 名匹配，而不是写死某个键，
                // 同时把实际键名返回给前端，便于确认 DSH 当前版本用的是哪个。
                const projectionValues =
                  item.projections && typeof item.projections.values === 'object' && item.projections.values
                    ? item.projections.values
                    : {}
                const titleKey = Object.keys(projectionValues).find(
                  (key) => /title/i.test(key) && typeof projectionValues[key] === 'string',
                )
                return {
                  sessionId: String(item.sessionId),
                  cwd: typeof item.cwd === 'string' ? item.cwd : null,
                  updatedAt: Number(item.updatedAt) || 0,
                  running: item.running === true,
                  agentAvailable: item.agentAvailable === true,
                  title: titleKey ? projectionValues[titleKey] : null,
                }
              })
              .sort((a, b) => b.updatedAt - a.updatedAt)
            sendJson(res, 200, { ok: true, sessions, archivedCount })
          } catch (error) {
            log('warn', `会话列表失败：${error?.message ?? error}`)
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }),
      }),
    )

    log('info', `设置页数据通道已就绪：${CONFIG_PATH}、${JOBS_PATH}、${SESSIONS_PATH}`)
  })

  // 扫描循环：用 ctx.effect 托管，卸载时自动清掉
  ctx.effect(() => {
    let stopped = false
    let scanning = false
    const tick = async () => {
      if (stopped || scanning) return
      // setInterval 不会等上一轮结束。间隔可以调到 6 秒，而一次扫描可能更久
      //（首次翻会话日志要几百毫秒到几秒），没有这道闸就会多个 scan 叠着跑。
      scanning = true
      try {
        await scan()
      } catch (error) {
        log('warn', `scan 失败：${error?.message ?? error}`)
      } finally {
        scanning = false
      }
    }
    const currentIntervalMs = () => Math.max(100, Math.round(settings.scanIntervalMin * 60) * 1000)
    let intervalMs = currentIntervalMs()
    let handle = setInterval(tick, intervalMs)
    // 改扫描间隔后要重建定时器才能生效（否则要重载插件）——设置页承诺的是"立即生效"。
    restartScanTimer = () => {
      const next = currentIntervalMs()
      if (next === intervalMs) return
      clearInterval(handle)
      intervalMs = next
      handle = setInterval(tick, intervalMs)
      log('info', `扫描间隔已调整为 ${settings.scanIntervalMin} 分钟`)
    }
    // 启动后先延迟一拍再扫，避免与插件激活争用
    setTimeout(tick, 3000)
    return () => {
      stopped = true
      clearInterval(handle)
      restartScanTimer = () => {}
    }
  })

  log(
    'info',
    `已加载，数据目录 ${dataDir()}，扫描间隔 ${settings.scanIntervalMin} 分钟，窗口 ${settings.windowStart}–${settings.windowEnd}`,
  )
}
