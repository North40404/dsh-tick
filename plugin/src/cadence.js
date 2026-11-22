// cadence：纯函数，无 I/O、无全局状态。
//
// 对应设计稿 §4.3 / 验收清单 B 组。
//
// 三型四态：
//   once   + inMinutes  相对一次性（创建时换算成绝对时间落盘）
//   once   + at         ISO 8601 带偏移的绝对一次性
//   fixed  + everyMinutes
//   random + minMinutes / maxMinutes   （下一次在排期时抽定，调用方负责落盘）
//
// 日历型（每天/工作日/每月）**不实现**，一律引导去用官方 schedule_create。

/** 单次间隔上限：30 天。更长请改用绝对时间。 */
export const MAX_MINUTES = 43200

/** 带偏移的 ISO 8601（Z 或 ±HH:MM 必须存在）。 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

const MINUTE_MS = 60_000

function fail(code, hint) {
  return { ok: false, code, hint }
}

function isInteger(v) {
  return typeof v === 'number' && Number.isInteger(v)
}

/** 整数且在 [lo, hi] 内。字符串、小数、NaN、Infinity 一律 false。 */
function inRange(v, lo, hi) {
  return isInteger(v) && v >= lo && v <= hi
}

/**
 * 校验并归一化 cadence。
 *
 * 归一化的唯一动作：`once + inMinutes` 会被换算成绝对时间 `at` 落盘，
 * 之后所有判定都只看绝对时间。这样重启后不会因"相对几十分钟"重算而漂移。
 *
 * @param {unknown} input - 模型/UI 传入的原始 cadence。
 * @param {{now: number, allowPast?: boolean}} opts
 * @returns {{ok: true, cadence: object} | {ok: false, code: string, hint: string}}
 */
export function normalizeCadence(input, { now, allowPast = false }) {
  if (!input || typeof input !== 'object') {
    return fail('invalid_type', 'cadence 必须是对象，例如 {"type":"once","inMinutes":20}')
  }

  const { type } = input

  // 日历型：不实现，明确引导（B9 / §10.6）
  if (type === 'calendar' || type === 'daily' || type === 'weekly' || type === 'workday') {
    return fail(
      'use_schedule_instead',
      '日历型需求请用 schedule_create（支持按天/按周规则）。DSH-Tick 只做间隔型调度。',
    )
  }

  if (type === 'once') return normalizeOnce(input, { now, allowPast })
  if (type === 'fixed') return normalizeFixed(input)
  if (type === 'random') return normalizeRandom(input)

  return fail('invalid_type', 'cadence.type 只能是 once / fixed / random')
}

function normalizeOnce(input, { now, allowPast }) {
  const hasIn = Object.prototype.hasOwnProperty.call(input, 'inMinutes')
  const hasAt = Object.prototype.hasOwnProperty.call(input, 'at')

  // B5：互斥
  if (hasIn && hasAt) {
    return fail('mutually_exclusive', 'inMinutes 与 at 只能给一个：相对时间用 inMinutes，绝对时刻用 at')
  }
  if (!hasIn && !hasAt) {
    return fail('missing_time', 'once 任务必须给 inMinutes（相对，如 20）或 at（ISO 带偏移，如 "2026-11-17T06:00:00+08:00"）')
  }

  if (hasIn) {
    // B10 / B11 / B12：严格整数、范围、**不做宽松解析**
    if (!inRange(input.inMinutes, 1, MAX_MINUTES)) {
      return fail(
        'invalid_number',
        `inMinutes 必须是 1~${MAX_MINUTES} 的整数（单位：分钟）。例如 20 表示 20 分钟后；更长时间请用 at 指定绝对时刻。`,
      )
    }
    return { ok: true, cadence: { type: 'once', at: now + input.inMinutes * MINUTE_MS } }
  }

  // B3 / B4：绝对时间必须是带偏移的 ISO 字符串
  if (typeof input.at !== 'string') {
    return fail(
      'invalid_time',
      'at 必须是带时区偏移的 ISO 8601 字符串，例如 "2026-11-17T06:00:00+08:00"。不接受裸时间戳（如 1792838400000）。',
    )
  }
  if (!ISO_WITH_OFFSET.test(input.at)) {
    return fail(
      'invalid_time',
      'at 缺少时区偏移。请写成 "2026-11-17T06:00:00+08:00" 或 "2026-11-16T22:00:00Z"。',
    )
  }
  const at = Date.parse(input.at)
  if (!Number.isFinite(at)) {
    return fail('invalid_time', `at 不是有效时间：${input.at}`)
  }
  if (!allowPast && at <= now) {
    return fail('time_in_past', `at 已经过去了（${input.at}）。请给一个将来时刻。`)
  }

  return { ok: true, cadence: { type: 'once', at } }
}

function normalizeFixed(input) {
  if (!inRange(input.everyMinutes, 1, MAX_MINUTES)) {
    return fail(
      'invalid_number',
      `everyMinutes 必须是 1~${MAX_MINUTES} 的整数（单位：分钟）。例如 30 表示每 30 分钟。`,
    )
  }
  return { ok: true, cadence: { type: 'fixed', everyMinutes: input.everyMinutes } }
}

function normalizeRandom(input) {
  if (!inRange(input.minMinutes, 1, MAX_MINUTES) || !inRange(input.maxMinutes, 1, MAX_MINUTES)) {
    return fail(
      'invalid_number',
      `minMinutes 与 maxMinutes 必须是 1~${MAX_MINUTES} 的整数（单位：分钟），例如 40 和 46。`,
    )
  }
  if (input.minMinutes > input.maxMinutes) {
    return fail('invalid_range', 'minMinutes 不能大于 maxMinutes，例如 {"minMinutes":40,"maxMinutes":46}')
  }
  return { ok: true, cadence: { type: 'random', minMinutes: input.minMinutes, maxMinutes: input.maxMinutes } }
}

/**
 * 在 [min, max] 里抽一个整数分钟（两端都包含）。
 * 抽定后**必须由调用方落盘**，否则重启会漂移（B7 / B8）。
 */
export function drawMinutes(minMinutes, maxMinutes, random = Math.random) {
  const span = maxMinutes - minMinutes + 1
  const r = Math.min(Math.max(random(), 0), 0.999999999)
  return minMinutes + Math.floor(r * span)
}

/**
 * 第一次到期时刻。基准是「创建时刻」，不是「上一次触发」。
 * @param {object} cadence - 已归一化的 cadence。
 * @param {number} fromMs - 基准时刻（通常是创建时刻）。
 * @param {() => number} [random]
 */
export function firstDueAt(cadence, fromMs, random = Math.random) {
  switch (cadence.type) {
    case 'once':
      return cadence.at
    case 'fixed':
      return fromMs + cadence.everyMinutes * MINUTE_MS
    case 'random':
      return fromMs + drawMinutes(cadence.minMinutes, cadence.maxMinutes, random) * MINUTE_MS
    default:
      throw new Error(`unknown cadence type: ${cadence.type}`)
  }
}

/**
 * 下一次到期时刻。基准是「上一次实际触发时刻」`fromMs`（不是原定的 dueAt）。
 * once 没有下一次，返回 null。
 */
export function nextDueAt(cadence, fromMs, random = Math.random) {
  if (cadence.type === 'once') return null
  return firstDueAt(cadence, fromMs, random)
}

/** 给 UI / tick_list 用的一句话摘要。 */
export function describeCadence(cadence) {
  if (cadence.type === 'once') return `一次性 @ ${new Date(cadence.at).toISOString()}`
  if (cadence.type === 'fixed') return `每 ${cadence.everyMinutes} 分钟`
  return `随机 ${cadence.minMinutes}~${cadence.maxMinutes} 分钟`
}
