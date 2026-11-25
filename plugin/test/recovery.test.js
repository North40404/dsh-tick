import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyScan,
  decideMissed,
  expiredUnreachable,
  nextAfterFire,
  pushMissed,
} from '../src/recovery.js'

const MIN = 60_000
const SCAN = MIN // 1 分钟

test('F3 · 长时间挂起被识别出来', () => {
  const now = 10 * MIN
  assert.deepEqual(classifyScan({ now, lastScanAt: 0, scanIntervalMs: SCAN }), { kind: 'first', delta: 0 })
  assert.deepEqual(classifyScan({ now, lastScanAt: now - SCAN, scanIntervalMs: SCAN }), {
    kind: 'normal',
    delta: SCAN,
  })
  assert.deepEqual(classifyScan({ now, lastScanAt: now - 5 * SCAN, scanIntervalMs: SCAN }), {
    kind: 'suspended',
    delta: 5 * SCAN,
  })
})

test('F4 · 时钟倒退被识别', () => {
  const result = classifyScan({ now: 1000, lastScanAt: 5000, scanIntervalMs: SCAN })
  assert.equal(result.kind, 'clock-back')
  assert.ok(result.delta < 0)
})

test('F10 · 周期任务错过 → 冻结重排，不补跑', () => {
  const job = { cadence: { type: 'fixed', everyMinutes: 30 }, nextDueAt: 10 * MIN, importance: 'normal' }
  const result = decideMissed(job, { now: 10 * MIN + 5 * 60 * MIN, lateToleranceMin: 30 })
  assert.equal(result.action, 'reschedule')
  assert.equal(result.lateMin, 300)
})

test('F11 · 周期 important 补告知（D22 改语义：不再静默冻结）', () => {
  const job = { cadence: { type: 'random', minMinutes: 40, maxMinutes: 46 }, nextDueAt: 10 * MIN, importance: 'important' }
  const result = decideMissed(job, { now: 10 * MIN + 8 * 60 * MIN, lateToleranceMin: 30 })
  assert.equal(result.action, 'miss')
  assert.equal(result.alsoReschedule, true)
})

test('F6 · once 迟到 20 分钟（容忍 30）→ 正常补发', () => {
  const job = { cadence: { type: 'once', at: 10 * MIN }, nextDueAt: 10 * MIN, importance: 'normal' }
  const result = decideMissed(job, { now: 30 * MIN, lateToleranceMin: 30 })
  assert.equal(result.action, 'fire')
  assert.equal(result.lateMin, 20)
})

test('F7 · once normal 迟到超限 → 静默丢弃', () => {
  const job = { cadence: { type: 'once', at: 10 * MIN }, nextDueAt: 10 * MIN, importance: 'normal' }
  const result = decideMissed(job, { now: 10 * MIN + 8 * 60 * MIN, lateToleranceMin: 30 })
  assert.equal(result.action, 'drop')
})

test('F8 · once important 迟到超限 → 补告知，不是执行原任务', () => {
  const job = { cadence: { type: 'once', at: 10 * MIN }, nextDueAt: 10 * MIN, importance: 'important' }
  const result = decideMissed(job, { now: 10 * MIN + 8 * 60 * MIN, lateToleranceMin: 30 })
  assert.equal(result.action, 'miss')
  assert.equal(result.lateMin, 480)
})

test('once 的容忍不随 importance 变（both 30 分钟）', () => {
  const normal = { cadence: { type: 'once', at: 0 }, nextDueAt: 0, importance: 'normal' }
  const important = { cadence: { type: 'once', at: 0 }, nextDueAt: 0, importance: 'important' }
  // 29 分钟 → 都 fire
  assert.equal(decideMissed(normal, { now: 29 * MIN, lateToleranceMin: 30 }).action, 'fire')
  assert.equal(decideMissed(important, { now: 29 * MIN, lateToleranceMin: 30 }).action, 'fire')
  // 31 分钟 → 分道扬镳
  assert.equal(decideMissed(normal, { now: 31 * MIN, lateToleranceMin: 30 }).action, 'drop')
  assert.equal(decideMissed(important, { now: 31 * MIN, lateToleranceMin: 30 }).action, 'miss')
})

test('未到期不算错过', () => {
  const job = { cadence: { type: 'once', at: 10 * MIN }, nextDueAt: 10 * MIN, importance: 'normal' }
  assert.deepEqual(decideMissed(job, { now: 5 * MIN, lateToleranceMin: 30 }), { action: 'not-due', lateMin: 0 })
})

test('nextAfterFire：周期从实际触发时刻算起，once 没有下一次', () => {
  const fixed = { cadence: { type: 'fixed', everyMinutes: 30 } }
  assert.equal(nextAfterFire(fixed, { firedAt: 100 * MIN }), 130 * MIN)

  const once = { cadence: { type: 'once', at: 10 * MIN } }
  assert.equal(nextAfterFire(once, { firedAt: 10 * MIN }), null)

  const random = { cadence: { type: 'random', minMinutes: 40, maxMinutes: 46 } }
  assert.equal(nextAfterFire(random, { firedAt: 0, random: () => 0 }), 40 * MIN)
})

test('F12 / N9 · missed 满时被挤出的条目留标记，不静默', () => {
  let list = []
  for (let i = 0; i < 3; i += 1) {
    list = pushMissed(list, { id: `tj_${i}`, dueAt: i * MIN }, 2)
  }
  assert.equal(list.length, 3) // 2 条真实 + 1 条满溢说明
  const marker = list.find((item) => item.dropReason === 'queue_full')
  assert.ok(marker, '必须有 queue_full 标记')
  assert.equal(marker.evicted, 1)
  // 最新的还在
  assert.equal(list.filter((item) => item.id).at(-1).id, 'tj_2')
})

// ── 僵尸任务清理（unreachable TTL）────────────────────────────────────────

const TTL = 24 * 60 * MIN // 24 小时

function unreachableJob(overrides = {}) {
  return {
    id: 'tj_x',
    unreachable: true,
    unreachableSince: 1000,
    nextDueAt: 2000,
    scratch: 'x',
    ...overrides,
  }
}

test('TTL · 刚好到点就清理', () => {
  const jobs = [unreachableJob({ unreachableSince: 1000 })]
  assert.equal(expiredUnreachable(jobs, 1000 + TTL, TTL).length, 1)
})

test('TTL · 差 1 毫秒不清理', () => {
  const jobs = [unreachableJob({ unreachableSince: 1000 })]
  assert.equal(expiredUnreachable(jobs, 1000 + TTL - 1, TTL).length, 0)
})

test('TTL · 非 unreachable 的任务一律不动', () => {
  const jobs = [
    unreachableJob({ id: 'a', unreachable: false, unreachableSince: 0 }),
    unreachableJob({ id: 'b', unreachable: undefined }),
    unreachableJob({ id: 'c', unreachable: 'yes' }),
  ]
  assert.equal(expiredUnreachable(jobs, 10 * TTL, TTL).length, 0)
})

test('TTL · unreachableSince 缺失时退回 lastErrorAt', () => {
  const jobs = [unreachableJob({ unreachableSince: undefined, lastErrorAt: 5000 })]
  assert.equal(expiredUnreachable(jobs, 5000 + TTL, TTL).length, 1)
  assert.equal(expiredUnreachable(jobs, 5000 + TTL - 1, TTL).length, 0)
})

test('TTL · 时间字段是脏数据时按「刚刚不可达」处理，绝不误删', () => {
  for (const bad of [undefined, null, 0, -5, Number.NaN, 'abc']) {
    const jobs = [unreachableJob({ unreachableSince: bad, lastErrorAt: bad })]
    assert.equal(expiredUnreachable(jobs, 10 * TTL, TTL).length, 0, `脏值 ${String(bad)} 不应被清理`)
  }
})

test('TTL · 混合列表只返回该清理的那些', () => {
  const now = 10 * TTL
  const jobs = [
    unreachableJob({ id: 'old', unreachableSince: now - TTL - 1 }),
    unreachableJob({ id: 'fresh', unreachableSince: now - TTL + 1 }),
    { id: 'normal', unreachable: false },
  ]
  const out = expiredUnreachable(jobs, now, TTL)
  assert.deepEqual(out.map((job) => job.id), ['old'])
})

test('F12 · 周期任务仅迟到 45 秒 → 正常触发（扫描粒度，不算错过）', () => {
  const job = { cadence: { type: 'random', minMinutes: 25, maxMinutes: 45 }, nextDueAt: 10 * MIN, importance: 'normal' }
  const result = decideMissed(job, { now: 10 * MIN + 45 * 1000, lateToleranceMin: 30 })
  assert.equal(result.action, 'fire')
  assert.equal(result.lateMin, 0)
})

test('F13 · 周期任务迟到 3 分钟（超过宽限）→ 仍冻结重排', () => {
  const job = { cadence: { type: 'fixed', everyMinutes: 30 }, nextDueAt: 10 * MIN, importance: 'normal' }
  const result = decideMissed(job, { now: 10 * MIN + 3 * MIN, lateToleranceMin: 30, graceMs: 90 * 1000 })
  assert.equal(result.action, 'reschedule')
})


// ── D22：重要周期任务补告知，且继续排期 ─────────────────────────
test('D22 · 重要周期任务超出宽限 → miss 且要求继续排期', () => {
  const job = { cadence: { type: 'random', minMinutes: 40, maxMinutes: 46 }, nextDueAt: 10 * MIN, importance: 'important' }
  const result = decideMissed(job, { now: 10 * MIN + 5 * MIN, lateToleranceMin: 30 })
  assert.equal(result.action, 'miss')
  assert.equal(result.alsoReschedule, true)
})

test('D22 · 普通周期任务超出宽限仍是静默顺延', () => {
  const job = { cadence: { type: 'fixed', everyMinutes: 30 }, nextDueAt: 10 * MIN, importance: 'normal' }
  const result = decideMissed(job, { now: 10 * MIN + 5 * MIN, lateToleranceMin: 30 })
  assert.equal(result.action, 'reschedule')
  assert.equal(result.alsoReschedule, undefined)
})
