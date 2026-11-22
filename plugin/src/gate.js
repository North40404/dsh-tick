// 硬门：到期之后、唤醒之前要过的检查。
//
// 对应设计稿 §6.4 / §七，验收清单 C 组。
//
// 只有同步纯判定 `evaluateGate`（窗口 / 次数 / 预算 / 不可达）。
//
// **不再有"等空闲"阶段**：`prompt` 用的是 `mode:'queue'`，宿主会把消息排到
// 当前回合之后自己开新一轮，本来就不会插话。以前手动轮询 `running` 再等待，
// 只会让忙超过阈值的提醒被丢掉或延后——那是净损失。
//
// 关键不变量：**once 豁免窗口**（C1 / D19）。窗口管的是"主动打搅"，
// 不管"你指定的时刻"。

import { dayKey, minutesOfDay, parseClockTime, withinWindow } from './timezone.js'

/** 全新的当日计数状态。spentTokens 是「当日该会话的累计 token」。 */
export function emptyState() {
  return { dayKey: null, ranToday: 0, spentTokens: 0, perJob: {} }
}

/** 跨自然日就把当日计数清零（K5）。 */
export function rollDay(state, now, timeZone) {
  const key = dayKey(now, timeZone)
  if (state.dayKey === key) return state
  return { dayKey: key, ranToday: 0, spentTokens: 0, perJob: {} }
}

/** 记一次执行（在真正唤醒之后调用）。token 由会话日志统计，不在这里累加。 */
export function recordRun(state, jobId) {
  const perJob = { ...state.perJob }
  perJob[jobId] = (perJob[jobId] ?? 0) + 1
  return { ...state, ranToday: state.ranToday + 1, perJob }
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
 *
 * 注：早期设计里的 `orphaned`（切换服务对象时冻结旧任务）与 `target-mismatch`
 * （任务绑定不是当前服务对象）都已删除——插件现在是**多会话各自独立**的模型，
 * 每个任务只对自己的 boundSessionId 负责，不存在"全局服务对象"。
 *
 * @param {object} job
 * @param {object} options
 * @param {number} options.now
 * @param {string} options.timeZone
 * @param {{window?: {start: string, end: string}}} options.policy
 * @param {{maxPerDay?: number}} [options.jobDefaults]
 * @param {{maxPerDay: number, maxRunsPerDay: number, budgetDailyTokens: number}} options.gates
 * @param {ReturnType<typeof emptyState>} options.state
 */
export function evaluateGate(job, { now, timeZone, policy, jobDefaults, gates, state }) {
  if (job.unreachable) return blocked('unreachable', '目标会话不可达')
  if (!job.enabled) return blocked('disabled', '任务已停用')

  // C1 / D19：once 只看时刻，不看窗口
  if (job.cadence.type !== 'once') {
    const start = parseClockTime(policy?.window?.start)
    const end = parseClockTime(policy?.window?.end)
    if (start !== null && end !== null) {
      const minutes = minutesOfDay(now, timeZone)
      if (!withinWindow(minutes, start, end)) {
        return blocked('window', `当前 ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} 不在窗口 ${policy.window.start}–${policy.window.end} 内`)
      }
    }
  }

  // C8：单任务每日次数
  const maxPerDay = job.maxPerDay ?? jobDefaults?.maxPerDay
  if (typeof maxPerDay === 'number' && (state.perJob[job.id] ?? 0) >= maxPerDay) {
    return blocked('max-per-day', `该任务今日已执行 ${state.perJob[job.id]} 次，达到上限 ${maxPerDay}`)
  }

  // 闸 3：全局每日次数
  if (state.ranToday >= gates.maxRunsPerDay) {
    return blocked('max-runs-per-day', `今日总执行已达上限 ${gates.maxRunsPerDay}`)
  }

  // C9 / C10：预算熔断（按当日会话 token，模型无法解除）
  // 0 表示「不限制」——否则用户想关掉预算时会填 0，结果把所有触发都拦死。
  if (gates.budgetDailyTokens > 0 && state.spentTokens >= gates.budgetDailyTokens) {
    return blocked(
      'budget',
      `今日已用 ${state.spentTokens.toLocaleString()} tokens，达到上限 ${gates.budgetDailyTokens.toLocaleString()}，已熔断`,
    )
  }

  return PASS
}

