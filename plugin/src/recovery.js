// 恢复与补偿的纯逻辑。
//
// 对应设计稿 §6.2 / §6.3 / §6.4，验收清单 F 组。
// 这里只有判定函数；真正的重排与唤醒由调度层调用它们后执行。

import { nextDueAt } from './cadence.js'

const MINUTE_MS = 60_000

/**
 * 自检环的扫描分类（§6.3 / F3 / F4）。
 *
 * `delta` 是墙钟差值：
 *   - 首次运行（lastScanAt 为 0）→ first
 *   - 负值 → clock-back（时钟倒退，全部重锚定）
 *   - 超过 factor 倍扫描间隔 → suspended（休眠/挂起，走补偿而不是当正常到期）
 *   - 其余 → normal
 *
 * @param {{now: number, lastScanAt: number, scanIntervalMs: number, factor?: number}} input
 */
export function classifyScan({ now, lastScanAt, scanIntervalMs, factor = 3 }) {
  if (!lastScanAt) return { kind: 'first', delta: 0 }
  const delta = now - lastScanAt
  if (delta < 0) return { kind: 'clock-back', delta }
  if (delta > scanIntervalMs * factor) return { kind: 'suspended', delta }
  return { kind: 'normal', delta }
}

/**
 * 错过之后怎么办（§6.4 / D17）。
 *
 * v1.8 语义：
 *   周期（含 important）→ **冻结**：不补跑，重新排下一次
 *   once 且迟到 ≤ 容忍   → fire（正常补发）
 *   once important 超限  → miss（进 missed 列表，补一次"告知"而非执行）
 *   once normal 超限     → drop（静默丢弃）
 *
 * @param {object} job
 * @param {{now: number, lateToleranceMin: number}} ctx
 */
/**
 * 周期任务的默认宽限（毫秒）。
 *
 * 扫描是分钟级的，到期时刻几乎总落在两次扫描之间，
 * 于是"迟到几十秒"是常态而非异常——宽限要比扫描间隔略大。
 */
export const DEFAULT_GRACE_MS = 90 * 1000

export function decideMissed(job, { now, lateToleranceMin, graceMs = DEFAULT_GRACE_MS }) {
  const lateMs = now - job.nextDueAt
  if (lateMs <= 0) return { action: 'not-due', lateMin: 0 }
  const lateMin = Math.floor(lateMs / MINUTE_MS)

  // 周期任务：过期的那一轮直接丢掉，重新排（不做补偿）。
  //
  // 但"迟到"必须分两种：
  //   · 扫描粒度造成的秒级迟到（到期时刻落在两次扫描之间）→ 正常触发
  //   · 真正错过（休眠、长时间卡顿）→ 冻结，重新排下一次
  //
  // 早期版本没有这个区分：只要 lateMs > 0 就 reschedule，
  // 而扫描间隔是分钟级，于是周期任务**永远等不到自己**（F12/F13 覆盖）。
  if (job.cadence.type !== 'once') {
    if (lateMs <= graceMs) return { action: 'fire', lateMin }
    return { action: 'reschedule', lateMin }
  }

  if (lateMin <= lateToleranceMin) {
    return { action: 'fire', lateMin }
  }

  if (job.importance === 'important') {
    return { action: 'miss', lateMin }
  }

  return { action: 'drop', lateMin }
}

/**
 * 一次执行之后的下一次排期。
 * @param {object} job
 * @param {{firedAt: number, random?: () => number}} ctx
 * @returns {number | null} once 返回 null
 */
export function nextAfterFire(job, { firedAt, random = Math.random }) {
  return nextDueAt(job.cadence, firedAt, random)
}

/**
 * 找出「长期不可达、该被清理」的任务（纯函数，便于测试）。
 *
 * 判定：`unreachable === true` 且距 `unreachableSince`（缺失时退回 `lastErrorAt`）
 * 已超过 `ttlMs`。时间字段异常（NaN / 缺失 / 非正数）按 `now` 处理，
 * 即当作"刚刚不可达"——宁可多留一会儿，也不能因为一条脏数据把任务误删。
 *
 * @param {Array<object>} jobs
 * @param {number} now
 * @param {number} ttlMs
 * @returns {Array<object>} 需要清理的任务
 */
export function expiredUnreachable(jobs, now, ttlMs) {
  const out = []
  for (const job of jobs ?? []) {
    if (job?.unreachable !== true) continue
    const raw = Number(job.unreachableSince ?? job.lastErrorAt)
    const since = Number.isFinite(raw) && raw > 0 ? raw : now
    if (now - since < ttlMs) continue
    out.push(job)
  }
  return out
}

/**
 * 往 missed 列表里加一条，超过上限丢最旧并打 `queue_full` 标记（F12 / N9）。
 *
 * **不得静默丢弃**：被挤出的条目要留下标记，让 UI 能显示"因为满了所以没通知你"。
 *
 * @param {Array<object>} list
 * @param {object} entry
 * @param {number} max
 */
export function pushMissed(list, entry, max) {
  const next = [...list, { ...entry, recordedAt: entry.recordedAt ?? entry.dueAt }]
  let evicted = 0
  while (next.length > max) {
    next.shift()
    evicted += 1
  }
  if (evicted > 0) {
    next.push({
      dropReason: 'queue_full',
      evicted,
      recordedAt: entry.dueAt,
      note: `missed 列表已满，${evicted} 条较早的错过记录被挤出`,
    })
  }
  return next
}
