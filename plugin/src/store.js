// 持久化层：只负责读写，不含任何业务判断。
//
// 对应设计稿 §6.9 / 验收清单 K3（schemaVersion）。
//
// 三张逻辑表：
//   jobs.json  任务定义（含 nextDueAt / boundSessionId / origin）
//   runs.jsonl 执行历史（追加写，每行一条；本阶段先留接口）
//   meta.json  运行状态（lastScanAt / schemaVersion / 服务对象 / 当日累计 / missed）
//
// 写入一律「临时文件 + rename」，避免断电时写出半个 JSON。

import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export const SCHEMA_VERSION = 1

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback)
    // 坏档不静默吞掉：让调用方看到，由上层决定是否备份后重建。
    throw error
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

/**
 * 打开一个存储目录。
 * @param {{dir: string}} options
 */
export async function openStore({ dir }) {
  await mkdir(dir, { recursive: true })

  const jobsPath = join(dir, 'jobs.json')
  const metaPath = join(dir, 'meta.json')
  const runsPath = join(dir, 'runs.jsonl')

  const jobsFile = await readJson(jobsPath, { schemaVersion: SCHEMA_VERSION, jobs: [] })
  const meta = await readJson(metaPath, {
    schemaVersion: SCHEMA_VERSION,
    lastScanAt: 0,
    targetSessionId: null,
    ranToday: 0,
    spentTokens: 0,
    gateState: null,
    missed: [],
  })

  // K3：版本不匹配就明确拒绝，不做隐式迁移。
  for (const [name, file] of [
    ['jobs', jobsFile],
    ['meta', meta],
  ]) {
    if (file.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`${name} schemaVersion=${file.schemaVersion}，期望 ${SCHEMA_VERSION}`)
    }
  }

  let jobs = jobsFile.jobs

  const api = {
    dir,
    get meta() {
      return meta
    },
    listJobs() {
      return jobs.map((job) => structuredClone(job))
    },
    getJob(id) {
      const found = jobs.find((job) => job.id === id)
      return found ? structuredClone(found) : undefined
    },
    async putJob(job) {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index >= 0) jobs[index] = structuredClone(job)
      else jobs.push(structuredClone(job))
      await writeJsonAtomic(jobsPath, { schemaVersion: SCHEMA_VERSION, jobs })
      return job
    },
    /**
     * 只在任务**仍然存在**时打补丁；不存在就返回 false（绝不复活）。
     *
     * 为什么需要它：一次评估可能要等空闲好几分钟，期间用户完全可能把这个任务删掉。
     * 落地阶段若用 putJob（不存在则新增），就会把已删除的任务写回去——
     * 表现为"删了又冒出来"，而且下次还会照样触发。
     */
    async updateJob(id, patch) {
      const index = jobs.findIndex((item) => item.id === id)
      if (index < 0) return false
      jobs[index] = { ...jobs[index], ...structuredClone(patch) }
      await writeJsonAtomic(jobsPath, { schemaVersion: SCHEMA_VERSION, jobs })
      return true
    },
    async removeJob(id) {
      const before = jobs.length
      jobs = jobs.filter((job) => job.id !== id)
      if (jobs.length === before) return false
      await writeJsonAtomic(jobsPath, { schemaVersion: SCHEMA_VERSION, jobs })
      return true
    },
    async setMeta(patch) {
      Object.assign(meta, patch)
      await writeJsonAtomic(metaPath, meta)
      return meta
    },
    /** 追加一条执行历史（runs.jsonl）。 */
    async appendRun(record) {
      const handle = await open(runsPath, 'a')
      try {
        await handle.write(`${JSON.stringify(record)}\n`)
      } finally {
        await handle.close()
      }
    },
  }

  return api
}
