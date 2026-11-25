// 插件配置。
//
// 为什么不用宿主 Config（schemastery）：
//   本地 link 安装的插件没有自己的 node_modules，`@deepseek-ai/schemastery`
//   解析不到（实测 `ERR_MODULE_NOT_FOUND`）。为一个 schema 引入依赖链不划算，
//   所以配置存在插件自己的数据目录里：`<dataDir>/settings.json`。
//
//   代价：不再走 profile 的 patch 层，宿主不会替我们校验。
//   收益：校验在本地做（validatePatch 逐键），而且**改配置不需要重启插件**。
//
// 写入必须原子（临时文件 + rename），避免断电写出半个 JSON。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const DEFAULTS = Object.freeze({
  enabled: true,
  windowStart: '08:00',
  windowEnd: '23:59',
  maxJobs: 5,
  maxImportantJobs: 3,
  allowModelCreate: true,
  maxPerDay: 15,
  maxRunsPerDay: 30,
  budgetDailyTokens: 300000000,
  minIntervalMin: 5,
  maxScratchChars: 200,
  lateToleranceOnceMin: 30,
  scanIntervalMin: 1,
  suspendDetectFactor: 3,
  missedMax: 20,
})

/** 设置页可提交的字段白名单（服务端只接受这些键）。 */
export const EDITABLE_KEYS = Object.freeze(Object.keys(DEFAULTS))

/**
 * 把用户可能写的各种时间写法归一成 `HH:MM`；不合法返回 null。
 * 接受：`8:9`、`08:9`、`8:09`、`08:09`、`0809`、`9`（= 09:00）。
 * 目的：别让人为了一个冒号被拒，也别让 `8:9` 变成"格式错误"。
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeHHMM(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null

  let hour
  let minute
  const withColon = /^(\d{1,2}):(\d{1,2})$/.exec(text)
  const fourDigit = /^(\d{2})(\d{2})$/.exec(text)
  const bareHour = /^(\d{1,2})$/.exec(text)

  if (withColon) {
    hour = Number(withColon[1])
    minute = Number(withColon[2])
  } else if (fourDigit) {
    hour = Number(fourDigit[1])
    minute = Number(fourDigit[2])
  } else if (bareHour) {
    hour = Number(bareHour[1])
    minute = 0
  } else {
    return null
  }

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * 逐键校验并归一化。返回 `{ ok: true, value }` 或 `{ ok: false, errors: {键: 说明} }`。
 * 客户端校验只影响体验，安全边界在这里。
 * @param {Record<string, unknown>} input
 */
export function validatePatch(input, current = null) {
  const errors = {}
  const value = {}

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { _: '请求体必须是一个对象' } }
  }

  for (const key of Object.keys(input)) {
    if (!EDITABLE_KEYS.includes(key)) {
      errors[key] = '未知配置项'
      continue
    }
    const raw = input[key]

    // 布尔开关：总开关与「允许模型自建任务」
    if (key === 'enabled' || key === 'allowModelCreate') {
      if (typeof raw !== 'boolean') errors[key] = '必须是 true 或 false'
      else value[key] = raw
      continue
    }

    if (key === 'windowStart' || key === 'windowEnd') {
      const normalized = normalizeHHMM(raw)
      if (normalized === null) errors[key] = '请填 0:00~23:59 之间的时间（8:9、0809 这类写法会自动补齐）'
      else value[key] = normalized
      continue
    }

    // 扫描间隔允许**一位小数**（0.1 = 6 秒），必须在整数校验之前处理
    if (key === 'scanIntervalMin') {
      const minutes = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
        errors[key] = '必须是数字'
        continue
      }
      const tenths = Math.round(minutes * 10)
      if (Math.abs(minutes * 10 - tenths) > 1e-9) {
        errors[key] = '最多保留一位小数，例如 0.5'
        continue
      }
      if (minutes < 0.1 || minutes > 60) {
        errors[key] = '必须在 0.1~60 之间（0.1 = 6 秒）'
        continue
      }
      // 归一化成一位小数，避免 0.30000000000000004 这类浮点毛刺
      value[key] = tenths / 10
      continue
    }

    const num = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
      errors[key] = '必须是整数'
      continue
    }
    if (key === 'lateToleranceOnceMin') {
      if (num < 0 || num > 120) {
        errors[key] = '必须在 0~120 之间'
        continue
      }
    } else if (key === 'budgetDailyTokens') {
      if (num < 0 || num > 1_000_000_000_000) {
        errors[key] = '必须在 0~1000000000000 之间'
        continue
      }
    } else if (key === 'maxScratchChars') {
      if (num < 20 || num > 2000) {
        errors[key] = '必须在 20~2000 之间'
        continue
      }
    } else if (key === 'maxJobs') {
      if (num < 1 || num > 50) {
        errors[key] = '必须在 1~50 之间'
        continue
      }
    } else if (key === 'maxImportantJobs') {
      if (num < 0 || num > 50) {
        errors[key] = '必须在 0~50 之间（0 = 不允许模型自建重要任务）'
        continue
      }
    } else if (key === 'maxPerDay') {
      if (num < 1 || num > 1000) {
        errors[key] = '必须在 1~1000 之间'
        continue
      }
    } else if (key === 'suspendDetectFactor') {
      if (num < 2 || num > 10) {
        errors[key] = '必须在 2~10 之间'
        continue
      }
    } else if (key === 'missedMax') {
      if (num < 1 || num > 100) {
        errors[key] = '必须在 1~100 之间'
        continue
      }
    } else if (num < 1 || num > 10000) {
      errors[key] = '必须在 1~10000 之间'
      continue
    }
    value[key] = num
  }

  // D25：间隔下限不能小于扫描间隔——扫描器跟不上，更短的间隔没有意义。
  // 只校验**本次显式传入**的 minIntervalMin，避免"把扫描间隔调到 60"这种无关改动被拦。
  if (errors.minIntervalMin === undefined && value.minIntervalMin !== undefined) {
    const effectiveScan = value.scanIntervalMin ?? current?.scanIntervalMin ?? DEFAULTS.scanIntervalMin
    if (value.minIntervalMin < effectiveScan) {
      errors.minIntervalMin =
        `周期任务最小间隔（${value.minIntervalMin} 分钟）不能小于扫描间隔（${effectiveScan} 分钟）`
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value }
}

function settingsPath(dir) {
  return join(dir, 'settings.json')
}

/**
 * 读取配置；文件不存在或损坏时回落到出厂默认（不覆盖原文件，便于用户自查）。
 * @param {string} dir
 * @returns {{settings: object, warning?: string}}
 */
export function loadSettings(dir) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(dir), 'utf8'))
    const checked = validatePatch(parsed)
    if (!checked.ok) {
      return { settings: { ...DEFAULTS }, warning: `settings.json 校验未通过：${JSON.stringify(checked.errors)}` }
    }
    return { settings: { ...DEFAULTS, ...checked.value } }
  } catch (error) {
    if (error?.code === 'ENOENT') return { settings: { ...DEFAULTS } }
    return { settings: { ...DEFAULTS }, warning: `settings.json 读取失败：${error?.message ?? error}` }
  }
}

/**
 * 原子写入配置。
 * @param {string} dir
 * @param {object} settings - 已校验过的完整配置
 */
export function saveSettings(dir, settings) {
  mkdirSync(dir, { recursive: true })
  const target = settingsPath(dir)
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  renameSync(tmp, target)
}
