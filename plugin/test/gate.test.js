import test from 'node:test'
import assert from 'node:assert/strict'

import { manualClock } from '../src/clock.js'
import { emptyState, evaluateGate, recordBlock, recordRun, rollDay } from '../src/gate.js'

const TZ = 'Asia/Shanghai'
const MIN = 60_000
const INSIDE = Date.parse('2026-11-16T20:00:00+08:00') // 20:00 上海
const NIGHT = Date.parse('2026-11-17T03:00:00+08:00') // 03:00 上海

const GATES = { maxPerDay: 15, maxRunsPerDay: 100, budgetDailyTokens: 300_000_000 }
const POLICY = { window: { start: '08:00', end: '23:59' } }

function job(overrides = {}) {
  return {
    id: 'tj_1',
    enabled: true,
    unreachable: false,
    boundSessionId: 'sess-A',
    cadence: { type: 'fixed', everyMinutes: 30 },
    importance: 'normal',
    ...overrides,
  }
}

function gate(j, overrides = {}) {
  return evaluateGate(j, {
    now: INSIDE,
    timeZone: TZ,
    policy: POLICY,
    gates: GATES,
    state: emptyState(),
    ...overrides,
  })
}

test('C1 · once 豁免窗口：凌晨 3 点的闹钟照样过闸', () => {
  const j = job({ cadence: { type: 'once', at: NIGHT } })
  const result = gate(j, { now: NIGHT })
  assert.equal(result.pass, true)
})

test('C2 · 周期任务在窗口外被拦下', () => {
  const result = gate(job(), { now: NIGHT })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'window')
  assert.match(result.detail, /03:00/)
})

test('窗口内放行', () => {
  assert.equal(gate(job()).pass, true)
})

test('窗口跨午夜（23:00–07:00）', () => {
  const policy = { window: { start: '23:00', end: '07:00' } }
  assert.equal(gate(job(), { now: NIGHT, policy }).pass, true) // 03:00 在窗口内
  assert.equal(gate(job(), { policy }).pass, false) // 20:00 不在
})

test('C8 · 单任务每日次数上限', () => {
  const j = job({ maxPerDay: 2 })
  const state = { dayKey: null, ranToday: 2, spentTokens: 0, perJob: { tj_1: 2 } }
  const result = gate(j, { state })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'max-per-day')
})

test('闸 3 · 全局每日次数上限', () => {
  const state = { dayKey: null, ranToday: 100, ranTodayRecurring: 100, spentTokens: 0, perJob: {} }
  const result = gate(job(), { state })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'max-runs-per-day')
})

test('C9b · 预算 0 表示不限制，不拦任何触发', () => {
  const state = { dayKey: null, ranToday: 0, spentTokens: 999_999_999, perJob: {} }
  const result = gate(job(), { state, gates: { ...GATES, budgetDailyTokens: 0 } })
  assert.equal(result.pass, true)
})

test('C9 · 预算熔断（token）', () => {
  const state = { dayKey: null, ranToday: 1, spentTokens: 300_000_000, perJob: {} }
  const result = gate(job(), { state })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'budget')
})

test('C11 · 多闸同时不过时，记录第一条（窗口优先于预算）', () => {
  const state = { dayKey: null, ranToday: 0, spentTokens: 999_999_999, perJob: {} }
  const result = gate(job(), { now: NIGHT, state })
  assert.equal(result.reason, 'window')
})

test('不可达 / 已停用 依次优先', () => {
  assert.equal(gate(job({ unreachable: true })).reason, 'unreachable')
  assert.equal(gate(job({ enabled: false })).reason, 'disabled')
})

test('K5 · 跨自然日重置当日计数', () => {
  const before = { dayKey: '2026-11-16', ranToday: 7, spentTokens: 3, perJob: { tj_1: 7 } }
  const after = rollDay(before, NIGHT, TZ)
  assert.equal(after.dayKey, '2026-11-17')
  assert.equal(after.ranToday, 0)
  assert.equal(after.spentTokens, 0)
  assert.deepEqual(after.perJob, {})
})

test('同一天不重置', () => {
  const state = rollDay(emptyState(), INSIDE, TZ)
  assert.equal(rollDay(state, INSIDE + MIN, TZ), state)
})

test('recordRun 只累加执行次数，不碰 token', () => {
  let state = rollDay(emptyState(), INSIDE, TZ)
  state = recordRun(state, 'tj_1')
  state = recordRun(state, 'tj_1')
  assert.equal(state.ranToday, 2)
  assert.equal(state.perJob.tj_1, 2)
  assert.equal(state.spentTokens, 0)
})


// ── D21 / D24：重要周期任务豁免窗口；全局次数只算周期 ────────────
test('D21 · 重要周期任务在窗口外也放行', () => {
  const important = job({ importance: 'important' })
  const result = evaluateGate(important, {
    now: NIGHT, timeZone: TZ, policy: POLICY, gates: GATES, state: emptyState(),
  })
  assert.equal(result.pass, true)
})

test('D21 · 普通周期任务在窗口外仍被拦', () => {
  const result = evaluateGate(job(), {
    now: NIGHT, timeZone: TZ, policy: POLICY, gates: GATES, state: emptyState(),
  })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'window')
})

test('D24 · 全局次数上限只数周期任务，一次性任务不占名额', () => {
  // 周期已到 30 次
  let state = emptyState()
  for (let i = 0; i < 30; i += 1) state = recordRun(state, 'tj_r', 'fixed')
  const gates = { ...GATES, maxRunsPerDay: 30 }

  const recurring = evaluateGate(job({ cadence: { type: 'fixed', everyMinutes: 30 } }), {
    now: INSIDE, timeZone: TZ, policy: POLICY, gates, state,
  })
  assert.equal(recurring.pass, false)
  assert.equal(recurring.reason, 'max-runs-per-day')

  // 一次性任务不受这个闸影响（窗口对 once 本就豁免）
  const once = evaluateGate(job({ id: 'tj_o', cadence: { type: 'once', at: INSIDE + MIN } }), {
    now: INSIDE, timeZone: TZ, policy: POLICY, gates, state,
  })
  assert.equal(once.pass, true)
})

test('D24 · 一次性任务的触发不增加周期计数', () => {
  let state = emptyState()
  state = recordRun(state, 'tj_o', 'once')
  state = recordRun(state, 'tj_o2', 'once')
  assert.equal(state.ranToday, 2)
  assert.equal(state.ranTodayRecurring, 0)
})

test('D23 · 只统计窗口/上限/预算三类拦截', () => {
  let state = emptyState()
  state = recordBlock(state, 'tj_1', 'window')
  state = recordBlock(state, 'tj_1', 'max-per-day')
  state = recordBlock(state, 'tj_1', 'disabled')      // 不计
  state = recordBlock(state, 'tj_1', 'unreachable')   // 不计
  assert.equal(state.blockedToday, 2)
  assert.equal(state.blockedPerJob.tj_1, 2)
})
