// 硬门：到期之后、唤醒之前要过的检查。
//
// 对应设计稿 §6.4 / §七，验收清单 C 组。
//
// 只有同步纯判定 ' + BT + 'evaluateGate' + BT + '（窗口 / 次数 / 预算 / 不可达）。
//
// **不再有"等空闲"阶段**：' + BT + 'prompt' + BT + ' 用的是 ' + BT + "mode:'queue'" + BT + '，宿主会把消息排到
// 当前回合之后自己开新一轮，本来就不会插话。
//
// 关键不变量：
//   · **once 豁免窗口**（C1 / D19）——窗口管的是"主动打搅"，不管"你指定的时刻"；
//   · **important 周期任务也豁免窗口**（D21）——重要=不许被规则压掉；
//   · **全局每日次数只统计周期任务**（D24）——一次性任务是"你指定的时刻"，不该占巡检名额。

import { dayKey, minutesOfDay, parseClockTime, withinWindow } from './timezone.js'

/** 全新的当日计数状态。spentTokens 是「当日该会话的累计 token」。 */
export function emptyState() {
  return {
    dayKey: null,
    ranToday: 0,
    ranTodayRecurring: 0,
    spentTokens: 0,
    perJob: {},
    blockedToday: 0,
    blockedPerJob: {},
  }
}

/** 跨自然日就把当日计数清零（K5）。 */
export function rollDay(state, now, timeZone) {
  const key = dayKey(now, timeZone)
  if (state.dayKey === key) return state
  return {
    dayKey: key,
    ranToday: 0,
    ranTodayRecurring: 0,
    spentTokens: 0,
    perJob: {},
    blockedToday: 0,
    blockedPerJob: {},
  }
}

/**
 * 记一次执行（在真正唤醒之后调用）。
 * @param {object} state
 * @param {string} jobId
 * @param {'once'|'fixed'|'random'} [cadenceType] 周期任务额外计入跨任务总闸
 */
export function recordRun(state, jobId, cadenceType = 'once') {
  const perJob = { ...state.perJob }
  perJob[jobId] = (perJob[jobId] ?? 0) + 1
  const recurring = cadenceType !== 'once'
  return {
    ...state,
    ranToday: state.ranToday + 1,
    ranTodayRecurring: (state.ranTodayRecurring ?? 0) + (recurring ? 1 : 0),
    perJob,
  }
}

/** 哪些拦截原因值得展示给用户（disabled / unreachable 已有独立徽章）。 */
export const COUNTED_BLOCK_REASONS = new Set(['window', 'max-per-day', 'max-runs-per-day', 'budget'])

/** 记一次「被规则挡下」。只在 COUNTED_BLOCK_REASONS 里计数。 */
export function recordBlock(state, jobId, reason) {
  if (!COUNTED_BLOCK_REASONS.has(reason)) return state
  const blockedPerJob = { ...(state.blockedPerJob ?? {}) }
  blockedPerJob[jobId] = (blockedPerJob[jobId] ?? 0) + 1
  return {
    ...state,
    blockedToday: (state.blockedToday ?? 0) + 1,
    blockedPerJob,
  }
}

function blocked(reason, detail) {
  return { pass: false, reason, detail }
}

const PASS = Object.freeze({ pass: true, reason: 'ok' })

/**
 * 同步硬门。
 *
 * 顺序即优先级（C11：多闸同时不过时，记录**第一条**）：
 *   unreachable → disabled → window → perJob 次数 → 全局次数 → 预算
 */
export function evaluateGate(job, { now, timeZone, policy, jobDefaults, gates, state }) {
  if (job.unreachable) return blocked('unreachable', '目标会话不可达')
  if (!job.enabled) return blocked('disabled', '任务已停用')

  // C1 / D19：once 只看时刻，不看窗口；D21：important 周期任务同享豁免
  const windowExempt = job.cadence.type === 'once' || job.importance === 'important'
  if (!windowExempt) {
    const start = parseClockTime(policy?.window?.start)
    const end = parseClockTime(policy?.window?.end)
    if (start !== null && end !== null) {
      const minutes = minutesOfDay(now, timeZone)
      if (!withinWindow(minutes, start, end)) {
        return blocked('window', '当前 ' + String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0') + ' 不在窗口 ' + policy.window.start + '–' + policy.window.end + ' 内')
      }
    }
  }

  // C8：单任务每日次数
  const maxPerDay = job.maxPerDay ?? jobDefaults?.maxPerDay
  if (typeof maxPerDay === 'number' && (state.perJob[job.id] ?? 0) >= maxPerDay) {
    return blocked('max-per-day', '该任务今日已执行 ' + state.perJob[job.id] + ' 次，达到上限 ' + maxPerDay)
  }

  // D24：全局每日次数只数周期任务——一次性任务是你指定的时刻，不占巡检名额
  if (job.cadence.type !== 'once' && (state.ranTodayRecurring ?? 0) >= gates.maxRunsPerDay) {
    return blocked('max-runs-per-day', '今日周期任务总执行已达上限 ' + gates.maxRunsPerDay)
  }

  // C9 / C10：预算熔断（按当日会话 token，模型无法解除）
  // 0 表示「不限制」——否则用户想关掉预算时会填 0，结果把所有触发都拦死。
  if (gates.budgetDailyTokens > 0 && state.spentTokens >= gates.budgetDailyTokens) {
    return blocked(
      'budget',
      '今日已用 ' + state.spentTokens.toLocaleString() + ' tokens，达到上限 ' + gates.budgetDailyTokens.toLocaleString() + '，已熔断',
    )
  }

  return PASS
}
