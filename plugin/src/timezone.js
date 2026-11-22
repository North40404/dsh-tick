// 时区工具：窗口判定与「自然日」都必须在**本地时区**下计算。
//
// 不能用 `new Date().getHours()`——那会跟随宿主机时区，
// 测试与部署环境一变就飘。这里统一用 Intl 指定 IANA 时区。

const formatterCache = new Map()

function formatter(timeZone) {
  let f = formatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    formatterCache.set(timeZone, f)
  }
  return f
}

/** 把一个时间戳拆成指定时区下的 {year, month, day, hour, minute}。 */
export function zonedParts(timestamp, timeZone) {
  const parts = formatter(timeZone).formatToParts(new Date(timestamp))
  const get = (type) => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24, // en-CA 在午夜可能给出 24
    minute: get('minute'),
  }
}

/** 时区下的「当天」标识，用于跨自然日重置计数器（K5）。 */
export function dayKey(timestamp, timeZone) {
  const { year, month, day } = zonedParts(timestamp, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 时区下的「当日分钟数」0..1439。 */
export function minutesOfDay(timestamp, timeZone) {
  const { hour, minute } = zonedParts(timestamp, timeZone)
  return hour * 60 + minute
}

/** "HH:MM" → 分钟数。非法返回 null。 */
export function parseClockTime(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/**
 * 是否落在窗口内。支持跨午夜（如 23:00–07:00），两端都算在内。
 * @param {number} minutes - 当日分钟数
 * @param {number} start
 * @param {number} end
 */
export function withinWindow(minutes, start, end) {
  if (start <= end) return minutes >= start && minutes <= end
  return minutes >= start || minutes <= end
}
