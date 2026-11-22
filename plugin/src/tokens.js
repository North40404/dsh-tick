// 当日 token 统计：从最新事件往回翻，累加 assistant/message 的 usage，
// 直到跨过当天 0 点（或翻到日志起点）为止。
//
// 抽成纯函数是为了可测：调用方注入 `fetchPage`，本模块只负责翻页与累加。
//
// **两种"停止"必须区分开**：
//   - 跨过 0 点 / 翻到日志起点 → 当日累计是完整的
//   - 翻满上限还没跨过 0 点     → 只是下界，调用方必须把这个事实暴露出去
// 旧实现把两者混成一个 `break`，于是"最近 1600 条事件的用量"被当成"今日用量"，
// 数字会随事件增长而变小（累计值单调递减是它的破绽）。

function usageSum(usage) {
  if (!usage || typeof usage !== 'object') return 0
  return (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
}

/**
 * @param {object} options
 * @param {(request: {beforeSeq?: unknown, maxMessages: number}) => Promise<any>} options.fetchPage
 * @param {number} options.startOfDay 当天 00:00 的时间戳（毫秒）
 * @param {number} [options.pageSize]
 * @param {number} [options.maxPages]
 * @returns {Promise<{total: number, complete: boolean, pages: number}>}
 *   `complete=false` 表示没翻到 0 点就到了上限，`total` 只是下界。
 */
export async function sumTodayTokens({ fetchPage, startOfDay, pageSize = 200, maxPages = 50 }) {
  let total = 0
  let beforeSeq
  let pages = 0

  for (let page = 0; page < maxPages; page += 1) {
    const request = { maxMessages: pageSize }
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq
    const value = await fetchPage(request)
    pages += 1

    const records = Array.isArray(value?.records) ? value.records : []
    if (records.length === 0) return { total, complete: true, pages }

    // 记录升序（seq0 最旧）。本页必须严格比上一页更旧，否则说明游标没推进——
    // 此时**先不要累加**，直接停手，避免把同一批数据重复计入。
    const oldestSeq = records[0]?.event?.seq
    if (beforeSeq !== undefined) {
      if (typeof oldestSeq !== 'number' || oldestSeq >= beforeSeq) {
        return { total, complete: false, pages }
      }
    }

    let crossed = false
    for (const record of records) {
      const event = record?.event
      if (!event) continue
      if (typeof event.time === 'number' && event.time < startOfDay) {
        crossed = true
        continue
      }
      if (event.type === 'assistant/message') total += usageSum(event.data?.usage)
    }

    // 跨过 0 点：今天的事件已经全部看过
    if (crossed) return { total, complete: true, pages }
    // 日志到头了（没有更早的了）：同样覆盖了今天
    if (value?.hasMore !== true) return { total, complete: true, pages }

    // 关键：`beforeSeq` 要传**本页最旧的 seq**。
    // 实测（DSH 0.2.2）：返回体里的 `cursor` 等于最新 seq；拿它当 beforeSeq
    // 只会排除掉一条、其余原样返回，于是每页几乎重复——曾把 320 万算成 5100 万。
    if (typeof oldestSeq !== 'number') {
      return { total, complete: false, pages }
    }
    beforeSeq = oldestSeq
  }

  return { total, complete: false, pages }
}

export { usageSum }
