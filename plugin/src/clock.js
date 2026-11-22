// 统一时间源。
//
// 设计要点（对应验收清单 T1）：所有 `now()` 必须经由这里取得，
// 不允许在业务代码里直接调用 `Date.now()`。否则 cadence 与补偿类用例
// 只能靠真实 sleep 去测，慢到没人愿意跑。
//
// 墙钟 vs 单调钟：本插件判定一律用墙钟（job 的语义是"几点"），
// 单调钟只用于「上次扫描到现在过了多久」的差值判断——那条路径由自检环
// 用 `lastScanAt` 自行实现，不依赖 clock 抽象。

/**
 * 生产用时钟。
 * @returns {{now: () => number}}
 */
export function systemClock() {
  return Object.freeze({ now: () => Date.now() })
}

/**
 * 测试用手动时钟：可任意推进、可倒退（用于负跳用例）。
 * @param {number} startMs - 起始墙钟毫秒。
 */
export function manualClock(startMs) {
  let t = startMs
  return {
    now: () => t,
    /** 前进（可为负，模拟时钟倒退）。 */
    advance(ms) {
      t += ms
      return t
    },
    /** 直接设定墙钟。 */
    set(ms) {
      t = ms
      return t
    },
  }
}
