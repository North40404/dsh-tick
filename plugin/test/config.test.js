import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, normalizeHHMM, validatePatch } from '../src/config.js'

test('normalizeHHMM 接受宽松写法并补齐成 HH:MM', () => {
  assert.equal(normalizeHHMM('08:09'), '08:09')
  assert.equal(normalizeHHMM('8:9'), '08:09')
  assert.equal(normalizeHHMM('8:09'), '08:09')
  assert.equal(normalizeHHMM('08:9'), '08:09')
  assert.equal(normalizeHHMM('0809'), '08:09')
  assert.equal(normalizeHHMM('9'), '09:00')
  assert.equal(normalizeHHMM('0:00'), '00:00')
  assert.equal(normalizeHHMM('23:59'), '23:59')
  assert.equal(normalizeHHMM('  8:9  '), '08:09')
})

test('normalizeHHMM 拒绝非法时间', () => {
  assert.equal(normalizeHHMM('24:00'), null)
  assert.equal(normalizeHHMM('12:60'), null)
  assert.equal(normalizeHHMM('8:9:1'), null)
  assert.equal(normalizeHHMM('abc'), null)
  assert.equal(normalizeHHMM(''), null)
  assert.equal(normalizeHHMM(null), null)
  assert.equal(normalizeHHMM(809), null)
})

test('validatePatch 把窗口时间归一化后存下来', () => {
  const result = validatePatch({ windowStart: '8:9', windowEnd: '2:30' })
  assert.equal(result.ok, true)
  assert.equal(result.value.windowStart, '08:09')
  assert.equal(result.value.windowEnd, '02:30')
})

test('validatePatch 拒绝越界时间并给出可读提示', () => {
  const result = validatePatch({ windowStart: '25:00' })
  assert.equal(result.ok, false)
  assert.match(result.errors.windowStart, /0:00~23:59/)
})

test('validatePatch 只接受白名单键', () => {
  const result = validatePatch({ nope: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.errors.nope, '未知配置项')
})

test('validatePatch 校验总开关是布尔值', () => {
  assert.equal(validatePatch({ enabled: false }).value.enabled, false)
  assert.equal(validatePatch({ enabled: 'yes' }).ok, false)
})

test('validatePatch 校验「允许模型建任务」是布尔值', () => {
  assert.equal(validatePatch({ allowModelCreate: false }).value.allowModelCreate, false)
  assert.equal(validatePatch({ allowModelCreate: true }).value.allowModelCreate, true)
  assert.equal(validatePatch({ allowModelCreate: 0 }).ok, false)
  assert.equal(DEFAULTS.allowModelCreate, true)
})

test('默认值包含总开关且窗口合法', () => {
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(normalizeHHMM(DEFAULTS.windowStart), DEFAULTS.windowStart)
  assert.equal(normalizeHHMM(DEFAULTS.windowEnd), DEFAULTS.windowEnd)
})

test('数值范围校验', () => {
  assert.equal(validatePatch({ maxJobs: 999 }).ok, false)
  assert.equal(validatePatch({ maxJobs: 5 }).value.maxJobs, 5)
  assert.equal(validatePatch({ lateToleranceOnceMin: 0 }).value.lateToleranceOnceMin, 0)
})

test('扫描间隔允许一位小数（0.1 = 6 秒）', () => {
  assert.equal(validatePatch({ scanIntervalMin: 0.1 }).value.scanIntervalMin, 0.1)
  assert.equal(validatePatch({ scanIntervalMin: 0.5 }).value.scanIntervalMin, 0.5)
  assert.equal(validatePatch({ scanIntervalMin: '1.5' }).value.scanIntervalMin, 1.5)
  assert.equal(validatePatch({ scanIntervalMin: 60 }).value.scanIntervalMin, 60)
})

test('扫描间隔拒绝两位小数、越界与非数字', () => {
  assert.match(validatePatch({ scanIntervalMin: 0.15 }).errors.scanIntervalMin, /一位小数/)
  assert.match(validatePatch({ scanIntervalMin: 0 }).errors.scanIntervalMin, /0\.1~60/)
  assert.match(validatePatch({ scanIntervalMin: 61 }).errors.scanIntervalMin, /0\.1~60/)
  assert.match(validatePatch({ scanIntervalMin: 'abc' }).errors.scanIntervalMin, /数字/)
  assert.match(validatePatch({ scanIntervalMin: '' }).errors.scanIntervalMin, /数字/)
})

test('其它数值字段仍必须是整数', () => {
  assert.match(validatePatch({ maxJobs: 2.5 }).errors.maxJobs, /整数/)
  assert.match(validatePatch({ maxRunsPerDay: 1.5 }).errors.maxRunsPerDay, /整数/)
})
