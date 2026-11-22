import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_MINUTES, drawMinutes, firstDueAt, nextDueAt, normalizeCadence } from '../src/cadence.js'

// 2026-11-16 20:00:00 +08:00
const T0 = Date.parse('2026-11-16T20:00:00+08:00')
const MIN = 60_000

const ok = (result) => {
  assert.equal(result.ok, true, `期望成功，实际 ${result.code}: ${result.hint}`)
  return result.cadence
}

test('B1 · 相对 once：inMinutes 换算成绝对时间', () => {
  const cadence = ok(normalizeCadence({ type: 'once', inMinutes: 20 }, { now: T0 }))
  assert.deepEqual(cadence, { type: 'once', at: T0 + 20 * MIN })
})

test('B2 · 绝对 once：带偏移的 ISO 直接落成时间戳', () => {
  const cadence = ok(normalizeCadence({ type: 'once', at: '2026-11-17T06:00:00+08:00' }, { now: T0 }))
  assert.deepEqual(cadence, { type: 'once', at: Date.parse('2026-11-17T06:00:00+08:00') })
})

test('B3 · 裸时间戳被拒', () => {
  const result = normalizeCadence({ type: 'once', at: 1792838400000 }, { now: T0 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_time')
  assert.match(result.hint, /ISO 8601/)
})

test('B4 · 缺时区偏移被拒', () => {
  const result = normalizeCadence({ type: 'once', at: '2026-11-17T06:00:00' }, { now: T0 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_time')
})

test('B5 · inMinutes 与 at 互斥', () => {
  const result = normalizeCadence({ type: 'once', inMinutes: 20, at: '2026-11-17T06:00:00+08:00' }, { now: T0 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'mutually_exclusive')
})

test('B6 · fixed：下一次 = 基准 + everyMinutes', () => {
  const cadence = ok(normalizeCadence({ type: 'fixed', everyMinutes: 30 }, { now: T0 }))
  assert.equal(firstDueAt(cadence, T0), T0 + 30 * MIN)
  assert.equal(nextDueAt(cadence, T0 + 5 * MIN), T0 + 35 * MIN)
})

test('B7 · random：抽定值由随机源决定（调用方必须落盘）', () => {
  const cadence = ok(normalizeCadence({ type: 'random', minMinutes: 40, maxMinutes: 46 }, { now: T0 }))
  const low = firstDueAt(cadence, T0, () => 0)
  const high = firstDueAt(cadence, T0, () => 0.999999)
  assert.equal(low, T0 + 40 * MIN)
  assert.equal(high, T0 + 46 * MIN)
})

test('B7b · drawMinutes 两端都包含', () => {
  assert.equal(drawMinutes(40, 46, () => 0), 40)
  assert.equal(drawMinutes(40, 46, () => 0.999999), 46)
  assert.ok(drawMinutes(40, 46, () => 0.5) >= 40)
})

test('B9 · 日历型引导到 schedule_create，且不产生 cadence', () => {
  for (const type of ['calendar', 'daily', 'weekly', 'workday']) {
    const result = normalizeCadence({ type, at: '09:00' }, { now: T0 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'use_schedule_instead')
    assert.match(result.hint, /schedule_create/)
    assert.equal(result.cadence, undefined)
  }
})

test('B10 / B12 · 非整数与字符串一律拒绝，不做宽松解析', () => {
  for (const bad of [20.5, '20', '20m', '20分钟', NaN, Infinity]) {
    const result = normalizeCadence({ type: 'once', inMinutes: bad }, { now: T0 })
    assert.equal(result.ok, false, `${String(bad)} 不应通过`)
    assert.equal(result.code, 'invalid_number')
  }
})

test('B11 · 超范围拒绝', () => {
  for (const bad of [0, -1, MAX_MINUTES + 1]) {
    const result = normalizeCadence({ type: 'once', inMinutes: bad }, { now: T0 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_number')
  }
})

test('once 的 at 在过去：默认拒绝，allowPast 时放行（重启补偿路径用）', () => {
  const past = '2026-11-16T06:00:00+08:00'
  const rejected = normalizeCadence({ type: 'once', at: past }, { now: T0 })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'time_in_past')

  const allowed = normalizeCadence({ type: 'once', at: past }, { now: T0, allowPast: true })
  assert.equal(allowed.ok, true)
})

test('random 的 min > max 报 invalid_range', () => {
  const result = normalizeCadence({ type: 'random', minMinutes: 46, maxMinutes: 40 }, { now: T0 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_range')
})

test('once 没有下一次', () => {
  const cadence = ok(normalizeCadence({ type: 'once', inMinutes: 20 }, { now: T0 }))
  assert.equal(nextDueAt(cadence, T0 + 20 * MIN), null)
})
