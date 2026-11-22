import test from 'node:test'
import assert from 'node:assert/strict'

import { sumTodayTokens } from '../src/tokens.js'

const DAY_START = Date.parse('2026-11-17T00:00:00+08:00')

/** 造一条 assistant/message 事件（带 seq，分页要用）。 */
function message(seq, time, input, output) {
  return {
    event: {
      type: 'assistant/message',
      seq,
      time,
      data: { usage: { inputTokens: input, outputTokens: output } },
    },
  }
}

function other(seq, time) {
  return { event: { type: 'user/message', seq, time, data: {} } }
}

/** 按调用顺序返回预设页；记录必须升序（seq0 最旧），与宿主实测一致。 */
function pager(pages) {
  let index = 0
  return async () => pages[index++] ?? { records: [], hasMore: false }
}

test('跨过 0 点即停，只累加今天的事件', async () => {
  const fetchPage = pager([
    {
      records: [
        message(1, DAY_START + 3600_000, 100, 20),
        other(2, DAY_START + 3600_000),
        message(3, DAY_START + 7200_000, 200, 30),
        message(4, DAY_START - 60_000, 999, 999), // 昨天，不计入
      ],
      hasMore: true,
      cursor: 4,
    },
  ])

  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START })
  assert.equal(result.total, 350) // 120 + 230
  assert.equal(result.complete, true)
  assert.equal(result.pages, 1)
})

test('用「本页最旧的 seq」当游标继续往回翻', async () => {
  const seen = []
  const pages = [
    { records: [message(30, DAY_START + 7200_000, 100, 10)], hasMore: true, cursor: 30 },
    { records: [message(20, DAY_START + 3600_000, 200, 20)], hasMore: true, cursor: 20 },
    { records: [message(10, DAY_START - 1000, 1, 1)], hasMore: true, cursor: 10 },
  ]
  let index = 0
  const fetchPage = async (request) => {
    seen.push(request.beforeSeq)
    return pages[index++] ?? { records: [], hasMore: false }
  }

  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START })
  assert.equal(result.total, 330) // 110 + 220
  assert.equal(result.complete, true)
  // 第一页无 beforeSeq；之后必须是最旧 seq（30 → 20），而不是 cursor 同值
  assert.deepEqual(seen, [undefined, 30, 20])
})

test('游标不前进时立刻停手并标记不完整（防止重复累加）', async () => {
  let calls = 0
  const fetchPage = async () => {
    calls += 1
    // 每页都返回同一批数据（正是 beforeSeq 用错时的真实表现）
    return { records: [message(5, DAY_START + 60_000, 10, 1)], hasMore: true, cursor: 5 }
  }

  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START, maxPages: 50 })
  assert.equal(result.complete, false)
  assert.equal(result.pages, 2) // 第一页学到游标=5，第二页发现没前进
  assert.equal(result.total, 11) // 只算了一次，没重复
  assert.equal(calls, 2)
})

test('翻到上限仍未跨过 0 点：complete=false，值只是下界', async () => {
  let page = 0
  const fetchPage = async () => {
    page += 1
    // 每页 seq 递减，模拟真实推进
    return { records: [message(10_000 - page * 100, DAY_START + 600_000, 10, 1)], hasMore: true }
  }

  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START, maxPages: 5 })
  assert.equal(result.complete, false)
  assert.equal(result.pages, 5)
  assert.equal(result.total, 55) // 5 页 × 11
})

test('日志到头（hasMore=false）算完整', async () => {
  const fetchPage = pager([
    { records: [message(1, DAY_START + 60_000, 50, 5)], hasMore: false },
  ])
  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START })
  assert.equal(result.total, 55)
  assert.equal(result.complete, true)
})

test('空页：完整且为 0', async () => {
  const fetchPage = pager([{ records: [], hasMore: false }])
  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START })
  assert.deepEqual(result, { total: 0, complete: true, pages: 1 })
})

test('事件缺 seq 无法推进时标记不完整', async () => {
  const fetchPage = pager([
    { records: [{ event: { type: 'assistant/message', time: DAY_START + 1000, data: { usage: { inputTokens: 5 } } } }], hasMore: true },
  ])
  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START })
  assert.equal(result.complete, false)
  assert.equal(result.total, 5)
})

test('usage 缺失或字段非数字时按 0 处理', async () => {
  const fetchPage = pager([
    {
      records: [
        { event: { type: 'assistant/message', seq: 1, time: DAY_START + 1000, data: {} } },
        message(2, DAY_START + 2000, '7', null),
        message(3, DAY_START + 3000, 3, 4),
      ],
      hasMore: false,
    },
  ])
  const result = await sumTodayTokens({ fetchPage, startOfDay: DAY_START })
  assert.equal(result.total, 14) // 0 + 7 + 7
})
