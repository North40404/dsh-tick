// 业务层：校验 + 组装 job。不碰 I/O，全部落在注入的 store 上。
//
// 对应设计稿 §四 / §七，验收清单 A 组与部分 H 组。

import { randomBytes } from 'node:crypto'
import { firstDueAt, nextDueAt, normalizeCadence } from './cadence.js'
import { INHERIT, applyPatch, resolveGate } from './settings.js'

const IMPORTANCE = new Set(['normal', 'important'])
const ORIGIN = new Set(['admin', 'model'])

function fail(code, hint) {
  return { ok: false, code, hint }
}

/** 按 Unicode 码点计字符数（中文/emoji 都算 1）。 */
function charLength(value) {
  return [...value].length
}

function newJobId() {
  return `tj_${randomBytes(4).toString('hex')}`
}

/**
 * @param {object} options
 * @param {Awaited<ReturnType<typeof import('./store.js').openStore>>} options.store
 * @param {{now: () => number}} options.clock
 * @param {object} [options.global] - 全局策略（来自 settings）
 * @param {() => number} [options.random] - 注入随机源，测试可固定
 */
export function createJobsService({ store, clock, global = {}, random = Math.random }) {
  const gate = (name) => resolveGate(name, { global })

  function validateScratch(scratch) {
    if (typeof scratch !== 'string') {
      return fail('invalid_scratch', 'scratch 必须是字符串，写一句你将来能看懂的任务说明')
    }
    const text = scratch.trim()
    const max = gate('maxScratchChars')
    if (text.length === 0) {
      return fail('empty_scratch', 'scratch 不能为空：写一句你将来能看懂的任务说明，例如"看看有没有想接的话"')
    }
    if (charLength(text) > max) {
      return fail(
        'scratch_too_long',
        `scratch 最多 ${max} 字，当前 ${charLength(text)} 字。请压缩成一句将来你能看懂的任务说明。`,
      )
    }
    return { ok: true, scratch: text }
  }

  /** 间隔型 cadence 的最小间隔地板（闸 1）。 */
  function checkIntervalFloor(cadence) {
    const floor = gate('minIntervalMin')
    const minutes =
      cadence.type === 'fixed' ? cadence.everyMinutes : cadence.type === 'random' ? cadence.minMinutes : null
    if (minutes === null) return null // once 没有间隔概念
    if (minutes >= floor) return null
    return fail(
      'interval_too_low',
      `间隔下限是 ${floor} 分钟，你给的是 ${minutes} 分钟。要更短需要管理员通过 approval 确认。`,
    )
  }

  function countImportantFromModel() {
    return store.listJobs().filter((job) => job.importance === 'important' && job.origin === 'model').length
  }

  function countActive() {
    return store.listJobs().length
  }

  /**
   * 配额统计（给设置页显示用）。
   *
   * **刻意实时计算**，不维护计数器：删除路径有五条（取消 / 触发后移除 / 错过移除 /
   * TTL 清理 / 丢弃），每条都记一次数的方案漏一条就永久漂移。任务上限本来就是个位数，
   * 现算的成本可以忽略，而且和闸用的是同一套函数——显示的数和拦你的数永远一致。
   */
  function stats() {
    return {
      total: countActive(),
      totalMax: gate('maxJobs'),
      // 重要名额只统计模型自建的那部分（管理员建的不占名额），与闸的口径一致
      important: countImportantFromModel(),
      importantMax: gate('maxImportantJobs'),
    }
  }

  /**
   * 创建 job。
   * @param {object} input - cadence / scratch / importance?
   * @param {{origin: 'admin'|'model', boundSessionId: string}} owner
   */
  async function create(input, owner) {
    // A8：origin 只能由调用方身份决定，input.origin 一律忽略
    if (!ORIGIN.has(owner?.origin)) {
      return fail('invalid_origin', 'origin 必须由调用方决定（admin 或 model），不能由参数传入')
    }
    if (!owner?.boundSessionId) {
      return fail('no_target_session', '没有绑定目标会话：请先在设置里选定服务对象')
    }
    // 管理员可以彻底关掉"模型自建任务"；设置页自己建任务不受影响。
    // 这个值是 getter 读的，所以保存配置后立即生效，不需要重载插件。
    if (owner.origin === 'model' && gate('allowModelCreate') === false) {
      return fail(
        'model_creation_disabled',
        '管理员已关闭模型自建任务：你不能再创建定时任务。需要的话请让管理员在设置页把「允许模型自建任务」打开。',
      )
    }

    const scratchResult = validateScratch(input?.scratch)
    if (!scratchResult.ok) return scratchResult

    const now = clock.now()
    const cadenceResult = normalizeCadence(input?.cadence, { now })
    if (!cadenceResult.ok) return cadenceResult
    const { cadence } = cadenceResult

    const floorResult = checkIntervalFloor(cadence)
    if (floorResult) return floorResult

    const importance = input?.importance ?? 'normal'
    if (!IMPORTANCE.has(importance)) {
      return fail('invalid_importance', 'importance 只能是 normal 或 important')
    }

    // 闸 2 与重要名额
    if (countActive() >= gate('maxJobs')) {
      return fail('limit_reached', `已有 ${gate('maxJobs')} 个任务，请先 tick_cancel 一个再建。`)
    }
    if (importance === 'important' && owner.origin === 'model') {
      if (countImportantFromModel() >= gate('maxImportantJobs')) {
        return fail(
          'important_limit',
          `模型创建的 important 任务最多 ${gate('maxImportantJobs')} 个。可以改用 normal，或请管理员在设置页直接创建。`,
        )
      }
    }

    const job = {
      id: newJobId(),
      enabled: true,
      cadence,
      scratch: scratchResult.scratch,
      importance,
      origin: owner.origin,
      boundSessionId: owner.boundSessionId,
      createdAt: now,
      nextDueAt: firstDueAt(cadence, now, random),
      lastFiredAt: null,
      unreachable: false,
    }

    await store.putJob(job)
    return { ok: true, job }
  }

  /** 修改。`"inherit"` 表示删除该字段回到继承（T10）。 */
  async function update(id, patch) {
    const job = store.getJob(id)
    if (!job) return fail('not_found', `找不到任务 ${id}`)

    const next = { ...job }

    if (patch?.scratch !== undefined) {
      const scratchResult = validateScratch(patch.scratch)
      if (!scratchResult.ok) return scratchResult
      next.scratch = scratchResult.scratch
    }

    if (patch?.cadence !== undefined) {
      const cadenceResult = normalizeCadence(patch.cadence, { now: clock.now() })
      if (!cadenceResult.ok) return cadenceResult
      const floorResult = checkIntervalFloor(cadenceResult.cadence)
      if (floorResult) return floorResult
      next.cadence = cadenceResult.cadence
      // 改了 cadence 必须重新排期，否则旧的 nextDueAt 还按老节奏走
      next.nextDueAt = firstDueAt(next.cadence, clock.now(), random)
    }

    if (patch?.importance !== undefined && patch.importance !== INHERIT) {
      if (!IMPORTANCE.has(patch.importance)) {
        return fail('invalid_importance', 'importance 只能是 normal 或 important')
      }
      if (
        patch.importance === 'important' &&
        job.importance !== 'important' &&
        job.origin === 'model' &&
        countImportantFromModel() >= gate('maxImportantJobs')
      ) {
        return fail('important_limit', `模型创建的 important 任务最多 ${gate('maxImportantJobs')} 个。`)
      }
    }

    const merged = applyPatch(next, patch ?? {})
    // 校验期间任务可能已被删除：用 updateJob 而不是 putJob，避免把它写回去
    if (!(await store.updateJob(id, merged))) {
      return fail('not_found', `任务 ${id} 已被删除`)
    }
    return { ok: true, job: merged }
  }

  async function cancel(id) {
    const removed = await store.removeJob(id)
    if (!removed) return fail('not_found', `找不到任务 ${id}`)
    return { ok: true }
  }

  function list({ detail = false } = {}) {
    const jobs = store.listJobs()
    if (detail) return jobs
    return jobs.map((job) => {
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
    })
  }

  return {
    create,
    update,
    cancel,
    list,
    stats,
    _validateScratch: validateScratch,
    _checkIntervalFloor: checkIntervalFloor,
  }
}

export { nextDueAt }
