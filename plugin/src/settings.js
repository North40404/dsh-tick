// 配置的四级生效链与安全闸。
//
// 对应设计稿 §4.1 / §9.3。
//
//   生效值 = job 显式值 ?? 模式预设 ?? 全局策略 ?? 出厂默认
//
// v1.8 之后 mode 只决定「是否自带预设任务」，不再提供参数预设，
// 所以 preset 这一层目前恒为空——保留形参是为了将来加预设时不必改调用点。
//
// **闸（GATES）不参与继承**：它们永远以全局为准，job 只能更严、不能放宽。
// 这条是结构性保证——闸根本不是 job 的字段。

/** 出厂默认（可被全局覆盖）。 */
export const FACTORY = Object.freeze({
  maxPerDay: 15,
})

/** 安全闸：只从全局读，永不被 job 覆盖。 */
export const GATES = Object.freeze({
  maxJobs: 5,
  maxImportantJobs: 3, // 只统计 origin === 'model'
  minIntervalMin: 1,
  maxRunsPerDay: 30,
  suspendDetectFactor: 3,
  budgetDailyTokens: 300_000_000,
  missedMax: 20,
  maxScratchChars: 200,
})

/** `"inherit"` 是 update 里恢复继承的哨兵值（T10）。 */
export const INHERIT = 'inherit'

function isInherit(v) {
  return v === INHERIT
}

/**
 * 解析一个**行为参数**（可被 job 覆盖）。
 * @param {string} name
 * @param {object|null} job
 * @param {{global?: object, preset?: object}|null} ctx
 */
export function resolveSetting(name, job, ctx) {
  const own = job?.[name]
  if (own !== undefined && own !== null && !isInherit(own)) return own

  const preset = ctx?.preset?.[name]
  if (preset !== undefined && preset !== null) return preset

  const global = ctx?.global?.[name]
  if (global !== undefined && global !== null) return global

  return FACTORY[name]
}

/**
 * 解析一个**安全闸**。job 完全无权参与。
 * @param {string} name
 * @param {{global?: object}|null} ctx
 */
export function resolveGate(name, ctx) {
  const global = ctx?.global?.[name]
  if (global !== undefined && global !== null) return global
  return GATES[name]
}

/**
 * update 用的合并：`"inherit"` 表示删掉该字段，回到继承。
 * @param {object} job
 * @param {Record<string, unknown>} patch
 */
export function applyPatch(job, patch) {
  const next = { ...job }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (isInherit(value)) delete next[key]
    else next[key] = value
  }
  return next
}

/** 迟到容忍（分钟）：`once` 固定 30，不随 importance 变（D17）。 */
export function lateToleranceMinutes(cadenceType, importance, ctx) {
  if (cadenceType === 'once') {
    return ctx?.global?.lateToleranceOnceMin ?? 30
  }
  // 周期任务在 v1.8 一律冻结重排，不产生迟到补偿；此值仅用于日志口径。
  return ctx?.global?.lateToleranceRecurringMin ?? 30
}
