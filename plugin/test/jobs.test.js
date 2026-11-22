import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { manualClock } from '../src/clock.js'
import { openStore } from '../src/store.js'
import { createJobsService } from '../src/jobs.js'

const T0 = Date.parse('2026-11-16T20:00:00+08:00')
const MIN = 60_000
const OWNER = { origin: 'admin', boundSessionId: 'sess-A' }

async function harness(t, { global = {}, random = () => 0.5 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tick-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const clock = manualClock(T0)
  const store = await openStore({ dir })
  const jobs = createJobsService({ store, clock, global, random })
  return { dir, clock, store, jobs }
}

test('A1 · 最简创建：cadence + scratch 就够', async (t) => {
  const { jobs } = await harness(t)
  const result = await jobs.create(
    { cadence: { type: 'random', minMinutes: 40, maxMinutes: 46 }, scratch: '看看有没有什么想做的' },
    OWNER,
  )
  assert.equal(result.ok, true)
  assert.match(result.job.id, /^tj_[0-9a-f]{8}$/)
  assert.equal(result.job.origin, 'admin')
  assert.equal(result.job.boundSessionId, 'sess-A')
  assert.equal(result.job.enabled, true)
})

test('A7 · 锚点快照：boundSessionId 来自创建时，不随全局变化', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tick-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const clock = manualClock(T0)

  const storeA = await openStore({ dir })
  const jobsA = createJobsService({ store: storeA, clock, global: {}, random: () => 0 })
  const created = await jobsA.create({ cadence: { type: 'fixed', everyMinutes: 30 }, scratch: 'a' }, OWNER)
  assert.equal(created.ok, true)

  // 重新打开（模拟重启），并把全局目标改成另一个会话
  const storeB = await openStore({ dir })
  await storeB.setMeta({ targetSessionId: 'sess-B' })
  const reloaded = storeB.getJob(created.job.id)
  assert.equal(reloaded.boundSessionId, 'sess-A')
})

test('A8 · origin 不可由参数伪造', async (t) => {
  const { jobs } = await harness(t)
  const result = await jobs.create(
    { cadence: { type: 'once', inMinutes: 20 }, scratch: 'x', origin: 'admin' },
    { origin: 'model', boundSessionId: 'sess-A' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.job.origin, 'model')
})

test('E3 · 空 scratch 拒绝', async (t) => {
  const { jobs } = await harness(t)
  const result = await jobs.create({ cadence: { type: 'once', inMinutes: 20 }, scratch: '   ' }, OWNER)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty_scratch')
})

test('E2 · 恰好 200 字通过', async (t) => {
  const { jobs } = await harness(t)
  const result = await jobs.create({ cadence: { type: 'once', inMinutes: 20 }, scratch: 'x'.repeat(200) }, OWNER)
  assert.equal(result.ok, true)
})

test('E1 · 201 字拒绝，且不落库', async (t) => {
  const { jobs, store } = await harness(t)
  const result = await jobs.create({ cadence: { type: 'once', inMinutes: 20 }, scratch: 'x'.repeat(201) }, OWNER)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'scratch_too_long')
  assert.equal(store.listJobs().length, 0)
})

test('闸 2 · 超过 maxJobs 拒绝', async (t) => {
  const { jobs } = await harness(t)
  for (let i = 0; i < 5; i += 1) {
    const r = await jobs.create({ cadence: { type: 'once', inMinutes: 10 + i }, scratch: `t${i}` }, OWNER)
    assert.equal(r.ok, true, `第 ${i + 1} 个应该成功`)
  }
  const sixth = await jobs.create({ cadence: { type: 'once', inMinutes: 30 }, scratch: 'x' }, OWNER)
  assert.equal(sixth.ok, false)
  assert.equal(sixth.code, 'limit_reached')
})

test('重要名额：模型最多 3 个，管理员不受限', async (t) => {
  const { jobs } = await harness(t)
  const model = { origin: 'model', boundSessionId: 'sess-A' }

  for (let i = 0; i < 3; i += 1) {
    const r = await jobs.create(
      { cadence: { type: 'once', inMinutes: 10 + i }, scratch: `m${i}`, importance: 'important' },
      model,
    )
    assert.equal(r.ok, true, `模型第 ${i + 1} 个 important 应成功`)
  }
  const fourth = await jobs.create(
    { cadence: { type: 'once', inMinutes: 40 }, scratch: 'm4', importance: 'important' },
    model,
  )
  assert.equal(fourth.ok, false)
  assert.equal(fourth.code, 'important_limit')

  // 管理员不占名额
  const adminImportant = await jobs.create(
    { cadence: { type: 'once', inMinutes: 50 }, scratch: 'a1', importance: 'important' },
    { origin: 'admin', boundSessionId: 'sess-A' },
  )
  assert.equal(adminImportant.ok, true)
})

test('闸 1 · 低于最小间隔地板需 approval', async (t) => {
  const { jobs } = await harness(t, { global: { minIntervalMin: 5 } })
  const result = await jobs.create({ cadence: { type: 'fixed', everyMinutes: 2 }, scratch: 'x' }, OWNER)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'interval_too_low')
  assert.match(result.hint, /approval/)
})

test('B8 · random 抽定后重启不漂移', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tick-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const clock = manualClock(T0)

  const storeA = await openStore({ dir })
  const jobsA = createJobsService({ store: storeA, clock, global: {}, random: () => 0.5 })
  const created = await jobsA.create(
    { cadence: { type: 'random', minMinutes: 40, maxMinutes: 46 }, scratch: 'x' },
    OWNER,
  )
  assert.equal(created.ok, true)
  const firstDue = created.job.nextDueAt

  // 重启，且换一个随机源——如果实现是"每次重算"，这里就会变
  const storeB = await openStore({ dir })
  const jobsB = createJobsService({ store: storeB, clock, global: {}, random: () => 0.999999 })
  const reloaded = jobsB.list().find((job) => job.id === created.job.id)
  assert.equal(reloaded.nextDueAt, firstDue)
  assert.equal(firstDue, T0 + 43 * MIN) // 0.5 → 40 + floor(0.5*7) = 43
})

test('取消任务', async (t) => {
  const { jobs, store } = await harness(t)
  const created = await jobs.create({ cadence: { type: 'once', inMinutes: 20 }, scratch: 'x' }, OWNER)
  const cancelled = await jobs.cancel(created.job.id)
  assert.equal(cancelled.ok, true)
  assert.equal(store.listJobs().length, 0)

  const again = await jobs.cancel(created.job.id)
  assert.equal(again.ok, false)
  assert.equal(again.code, 'not_found')
})

test('update 改 cadence 会重新排期', async (t) => {
  const { jobs, clock } = await harness(t)
  const created = await jobs.create({ cadence: { type: 'fixed', everyMinutes: 30 }, scratch: 'x' }, OWNER)
  assert.equal(created.job.nextDueAt, T0 + 30 * MIN)

  clock.advance(5 * MIN)
  const updated = await jobs.update(created.job.id, { cadence: { type: 'fixed', everyMinutes: 10 } })
  assert.equal(updated.ok, true)
  assert.equal(updated.job.nextDueAt, T0 + 5 * MIN + 10 * MIN)
})

test('list 默认精简，不带 scratch 全文', async (t) => {
  const { jobs } = await harness(t)
  await jobs.create({ cadence: { type: 'once', inMinutes: 20 }, scratch: '这是一段说明' }, OWNER)
  const lite = jobs.list()
  assert.equal(lite.length, 1)
  assert.equal('scratch' in lite[0], false)

  const full = jobs.list({ detail: true })
  assert.equal(full[0].scratch, '这是一段说明')
})

test('精简投影必须是 lossless JSON（不能含 undefined）', async (t) => {
  const { jobs } = await harness(t)
  await jobs.create({ cadence: { type: 'once', inMinutes: 20 }, scratch: 'x' }, OWNER)

  const lite = jobs.list()
  // 任何 undefined 自有属性都会让 JSON 往返后丢键，导致两者不等
  assert.deepEqual(JSON.parse(JSON.stringify(lite)), lite)
  for (const value of Object.values(lite[0])) assert.notEqual(value, undefined)
})

test('detail 列表也必须是 lossless JSON（不能含 undefined）', async (t) => {
  const { jobs } = await harness(t)
  await jobs.create({ cadence: { type: 'once', inMinutes: 20 }, scratch: 'x' }, OWNER)

  // tick_list 的 detail 分支返回原始记录，曾因某个 undefined 字段整条报错
  const detail = jobs.list({ detail: true })
  assert.deepEqual(JSON.parse(JSON.stringify(detail)), detail)
  for (const value of Object.values(detail[0])) assert.notEqual(value, undefined)
})

test('allowModelCreate=false 时模型不能建任务，管理员不受影响，且切换立即生效', async (t) => {
  const global = { allowModelCreate: true }
  const { jobs } = await harness(t, { global })
  const cadence = { type: 'fixed', everyMinutes: 30 }

  const first = await jobs.create({ cadence, scratch: 'a' }, { origin: 'model', boundSessionId: 's1' })
  assert.equal(first.ok, true)

  // 直接改全局对象（模拟保存配置后 getter 立刻返回新值），不重建服务
  global.allowModelCreate = false

  const blocked = await jobs.create({ cadence, scratch: 'b' }, { origin: 'model', boundSessionId: 's1' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'model_creation_disabled')
  assert.match(blocked.hint, /管理员已关闭模型自建任务/)

  // 管理员（设置页）不受这个开关影响
  const admin = await jobs.create({ cadence, scratch: 'c' }, { origin: 'admin', boundSessionId: 's1' })
  assert.equal(admin.ok, true)

  // 打开后模型又能建
  global.allowModelCreate = true
  const again = await jobs.create({ cadence, scratch: 'd' }, { origin: 'model', boundSessionId: 's1' })
  assert.equal(again.ok, true)
})

test('stats 与闸同源：管理员建的重要任务不占模型名额', async (t) => {
  const { jobs } = await harness(t, { global: { maxJobs: 5, maxImportantJobs: 3 } })
  const cadence = { type: 'fixed', everyMinutes: 30 }

  await jobs.create({ cadence, scratch: 'a', importance: 'important' }, { origin: 'model', boundSessionId: 's1' })
  await jobs.create({ cadence, scratch: 'b', importance: 'important' }, { origin: 'admin', boundSessionId: 's1' })
  await jobs.create({ cadence, scratch: 'c', importance: 'normal' }, { origin: 'model', boundSessionId: 's2' })

  assert.deepEqual(jobs.stats(), { total: 3, totalMax: 5, important: 1, importantMax: 3 })
})

test('stats 实时反映删除（不依赖计数器）', async (t) => {
  const { jobs } = await harness(t, { global: { maxJobs: 5, maxImportantJobs: 3 } })
  const created = await jobs.create(
    { cadence: { type: 'once', inMinutes: 30 }, scratch: 'x', importance: 'important' },
    { origin: 'model', boundSessionId: 's1' },
  )
  assert.equal(jobs.stats().total, 1)
  assert.equal(jobs.stats().important, 1)

  await jobs.cancel(created.job.id)
  assert.equal(jobs.stats().total, 0)
  assert.equal(jobs.stats().important, 0)
})

test('updateJob 只更新已存在的任务，绝不复活已删除的', async (t) => {
  const { jobs, store } = await harness(t, { global: { maxJobs: 5, maxImportantJobs: 3 } })
  const created = await jobs.create(
    { cadence: { type: 'fixed', everyMinutes: 30 }, scratch: 'x' },
    { origin: 'model', boundSessionId: 's1' },
  )
  const id = created.job.id

  // 正常更新：合并补丁
  assert.equal(await store.updateJob(id, { scratch: 'y' }), true)
  assert.equal(store.getJob(id).scratch, 'y')

  // 删掉之后再更新：必须拒绝，且不能把任务写回来
  await jobs.cancel(id)
  assert.equal(store.getJob(id), undefined)
  assert.equal(await store.updateJob(id, { scratch: 'z' }), false)
  assert.equal(store.getJob(id), undefined)
  assert.equal(jobs.list({ detail: true }).length, 0)

  // 服务层的 update 也必须报 not_found
  const result = await jobs.update(id, { scratch: 'w' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_found')
  assert.equal(jobs.list({ detail: true }).length, 0)
})
