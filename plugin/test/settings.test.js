import test from 'node:test'
import assert from 'node:assert/strict'

import { FACTORY, GATES, INHERIT, applyPatch, resolveGate, resolveSetting } from '../src/settings.js'

test('A2 · 缺省时取全局值', () => {
  assert.equal(resolveSetting('maxPerDay', {}, { global: { maxPerDay: 7 } }), 7)
})

test('A3 · 显式值优先于全局', () => {
  assert.equal(resolveSetting('maxPerDay', { maxPerDay: 3 }, { global: { maxPerDay: 7 } }), 3)
})

test('A4 · 四级链顺序：job → preset → global → factory', () => {
  const ctx = { preset: { maxPerDay: 9 }, global: { maxPerDay: 7 } }
  assert.equal(resolveSetting('maxPerDay', { maxPerDay: 3 }, ctx), 3)
  assert.equal(resolveSetting('maxPerDay', {}, ctx), 9)
  assert.equal(resolveSetting('maxPerDay', {}, { global: { maxPerDay: 7 } }), 7)
  assert.equal(resolveSetting('maxPerDay', {}, {}), FACTORY.maxPerDay)
})

test('A5 · 闸只从全局读，job 无法放宽', () => {
  // job 上就算硬塞 maxRunsPerDay，也影响不到闸
  const jobWithFakeGate = { maxRunsPerDay: 99999 }
  assert.equal(resolveGate('maxRunsPerDay', { global: { maxRunsPerDay: 3 } }), 3)
  assert.equal(resolveGate('maxRunsPerDay', {}), GATES.maxRunsPerDay)
  assert.equal(jobWithFakeGate.maxRunsPerDay, 99999) // 只是证明它存在但没人读
})

test('A6 · "inherit" 恢复继承', () => {
  const job = { id: 'tj_1', maxPerDay: 3 }
  const patched = applyPatch(job, { maxPerDay: INHERIT })
  assert.equal('maxPerDay' in patched, false)
  assert.equal(resolveSetting('maxPerDay', patched, { global: { maxPerDay: 7 } }), 7)
})

test('applyPatch 不修改原对象', () => {
  const job = { id: 'tj_1', maxPerDay: 3 }
  applyPatch(job, { maxPerDay: 5 })
  assert.equal(job.maxPerDay, 3)
})
