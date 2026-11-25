// DSH-Tick · Client 半：设置页（参数 + 任务管理）
//
// 形状依据宿主 `dsh-doc` 的 `templates/decoration/client.js` 与 ui-plugin.md：
//   · 浏览器侧通过 window.__ModuleLoader__.load 注册惰性工厂，id = 包名；
//   · 插槽注册是 ctx.slots.inject(slot, () => ctx.slots.register(opts, Component))；
//   · apply 必须 fail-soft，异常不得逃逸到宿主。
//
// 与 Host 的通信走普通 HTTP：
//   GET/POST /api/dsh-tick/config   → 参数
//   GET/POST /api/dsh-tick/jobs     → 任务 CRUD

window.__ModuleLoader__.load({
  id: 'dsh-tick',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG_PATH = '/api/dsh-tick/config'
    const JOBS_PATH = '/api/dsh-tick/jobs'
    const SESSIONS_PATH = '/api/dsh-tick/sessions'

    /**
     * 会话下拉项的显示文本：优先用 DSH 的会话标题，其次工作区名，再其次短 id。
     * 标题来自 SessionSummary.projections.values.title（实测该键存在）。
     */
    function sessionLabel(session) {
      const title = typeof session?.title === 'string' ? session.title.trim() : ''
      const cwd = session?.cwd ? String(session.cwd).split(/[\\/]/).filter(Boolean).pop() : ''
      const name = title || cwd || '未命名会话'
      const id = String(session?.sessionId ?? '').slice(0, 6)
      const when = typeof session?.updatedAt === 'number' ? formatTime(session.updatedAt) : '—'
      return `${name} · ${id} · ${when}${session?.running ? ' · 运行中' : ''}`
    }

    const FIELDS = [
      { key: 'windowStart', label: '活跃窗口开始', kind: 'time', hint: 'HH:MM（24 小时制）。周期任务只在这个窗口内触发；一次性闹钟不受窗口限制。' },
      { key: 'windowEnd', label: '活跃窗口结束', kind: 'time', hint: 'HH:MM。可跨午夜，例如 08:00 → 02:00。' },
      { key: 'scanIntervalMin', label: '扫描间隔（分钟）', min: 0.1, max: 60, step: 0.1, emphasis: true, hint: '【关键参数】每轮扫描都会检查所有任务是否到期，所以它直接决定任务的最晚误差——最大迟到 ≈ 这个值。可填一位小数：0.1 = 6 秒、0.5 = 30 秒、1 = 1 分钟。设得过小收益有限（任务节奏的下限本身就是 1 分钟），但会让扫描更频繁。' },
      { key: 'maxJobs', label: '任务总数上限', min: 1, max: 50, hint: '所有会话合计。到上限后不能再新建，已有任务保留。最小 1 —— 这里填 0 会被拒绝，不表示"不限"。' },
      { key: 'maxImportantJobs', label: '模型可建的重要任务上限', min: 0, max: 50, hint: '只统计它自己建的 important 任务；你在这里建的不占名额。填 0 = 不允许它建重要任务（不是不限）。' },
      { key: 'maxPerDay', label: '单任务每日上限', min: 1, max: 1000, hint: '同一个任务一天最多触发几次，防止高频任务刷屏。最小 1 —— 填 0 会被拒绝。' },
      { key: 'maxRunsPerDay', label: '每日总执行次数上限', min: 1, max: 10000, hint: '所有任务合计，到线后当天不再触发。最小 1 —— 填 0 会被拒绝。' },
      { key: 'budgetDailyTokens', label: '每日 token 上限（每个会话）', min: 0, max: 1000000000000, hint: '每个会话每天最多用多少 token；超过就停止给它触发任务。各会话互不影响，只影响定时触发，不影响你正常聊天。填 0 = 不限制（这个参数 0 就是"关掉预算"）。' },
      { key: 'minIntervalMin', label: '周期任务最小间隔（分钟）', min: 1, max: 10000, hint: '低于这个值的周期任务会被拒绝。最小 1 —— 填 0 会被拒绝。' },
      { key: 'suspendDetectFactor', label: '挂起检测倍数', min: 2, max: 10, hint: '两次扫描的间隔超过「扫描间隔 × 该倍数」，就判定为系统休眠/挂起并走补偿，而不是当正常到期。检测窗口有 60 秒下限，所以扫描间隔很小时也不会误判。' },
      { key: 'lateToleranceOnceMin', label: '一次性任务迟到容忍（分钟）', min: 0, max: 120, hint: '超过它就算「错过」：普通任务静默丢弃，重要任务补一次告知。填 0 = 不允许迟到，晚一分钟也按错过处理。' },
      { key: 'missedMax', label: '错过提醒最多保留', min: 1, max: 100, hint: '「错过的提醒」列表长度上限，超出丢最旧并留一条满溢说明。最小 1 —— 填 0 会被拒绝。' },
      { key: 'maxScratchChars', label: '任务说明最大字数', min: 20, max: 2000, hint: 'scratch 每次触发都会重复注入，不宜过大。最小值 20。' },
    ]

    /** 与 Host 侧 normalizeHHMM 同规则：8:9 / 0809 / 9 → HH:MM；不合法返回 null。 */
    function normalizeHHMM(raw) {
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
      } else return null
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    }

    /** 提交前的前端校验：和后端 validatePatch 同规则，只是为了让用户当场看到问题。 */
    function validateConfig(config) {
      const errors = {}
      for (const field of FIELDS) {
        const raw = config?.[field.key]
        if (field.kind === 'time') {
          if (normalizeHHMM(raw) === null) {
            errors[field.key] = '请填 0:00~23:59 之间的时间（8:9、0809 这类写法会自动补齐）'
          }
          continue
        }
        const text = String(raw ?? '').trim()
        if (text === '') {
          errors[field.key] = '不能为空'
          continue
        }
        const num = Number(text)
        if (!Number.isFinite(num)) {
          errors[field.key] = '必须是数字'
          continue
        }
        if (field.step && field.step < 1) {
          // 允许一位小数（如扫描间隔 0.5 分钟）
          const tenths = Math.round(num * 10)
          if (Math.abs(num * 10 - tenths) > 1e-9) {
            errors[field.key] = '最多保留一位小数，例如 0.5'
            continue
          }
        } else if (!Number.isInteger(num)) {
          errors[field.key] = '必须是整数'
          continue
        }
        if (num < field.min || num > field.max) {
          errors[field.key] = `必须在 ${field.min}~${field.max} 之间`
        }
      }
      return errors
    }

    /**
     * 「新建主动聊天任务」的预设。
     *
     * 与设计稿 §9.4 的 mode: chat 相比，这里不做全局模式：
     * 模式本质是"全局开关 + 隐藏的预设任务"，而任务本来就是普通 job，
     * 用按钮直接建出来更简单——看得见、改得动、删得掉，没有额外状态。
     *
     * 间隔取 60~90 分钟：早期设计是 40~46 分钟，那是给群聊用的（群里人多，
     * 模型挑着说话，不吭声很正常）。现在是一对一私聊且手机会弹通知，
     * 40 分钟一次等于一天二十多条通知，太吵。
     */
    const CHAT_JOB_SCRATCH = '这次只为聊天：想到什么就说，没话就什么都不说。'
    const CHAT_JOB_CADENCE = { type: 'random', minMinutes: 60, maxMinutes: 90 }

    const emptyDraft = {
      mode: 'once',
      inMinutes: '20',
      atLocal: '',
      utcOffset: '8',
      everyMinutes: '30',
      minMinutes: '40',
      maxMinutes: '46',
      scratch: '',
      importance: 'normal',
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '720px' },
      section: { display: 'flex', flexDirection: 'column', gap: '12px' },
      sectionTitle: { fontSize: '14px', fontWeight: 600, margin: 0 },
      intro: { fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      // 关键参数的行：左侧强调边 + 淡底色，让它在长列表里一眼可见
      rowEmphasis: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 10px',
        borderLeft: '3px solid var(--dsw-alias-text-accent, #2563eb)',
        borderRadius: '4px',
        background: 'var(--dsw-alias-bg-elevated, #f8fafc)',
      },
      badgeImportant: {
        fontSize: '11px',
        padding: '1px 6px',
        marginLeft: '6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-text-accent, #2563eb)',
        color: 'var(--dsw-alias-text-accent, #2563eb)',
      },
      label: { fontSize: '13px', fontWeight: 600 },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      input: {
        padding: '6px 8px',
        fontSize: '13px',
        border: '1px solid var(--dsw-alias-border, #d1d5db)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg, transparent)',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      shortInput: {
        padding: '6px 8px',
        fontSize: '13px',
        border: '1px solid var(--dsw-alias-border, #d1d5db)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg, transparent)',
        color: 'inherit',
        width: '140px',
        boxSizing: 'border-box',
      },
      error: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #dc2626)' },
      actions: { display: 'flex', alignItems: 'center', gap: '12px' },
      button: {
        padding: '6px 14px',
        fontSize: '13px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #d1d5db)',
        background: 'var(--dsw-alias-bg-elevated, #f3f4f6)',
        color: 'inherit',
        cursor: 'pointer',
      },
      smallButton: {
        padding: '3px 10px',
        fontSize: '12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #d1d5db)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      status: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      statusWarn: { fontSize: '12px', color: '#b45309' },
      statusDanger: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #dc2626)' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        borderRadius: '8px',
      },
      itemMain: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
      itemTitle: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      itemMeta: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border, #d1d5db)',
        marginLeft: '6px',
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px',
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        borderRadius: '8px',
      },
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function describeCadence(cadence) {
      if (!cadence) return '—'
      if (cadence.type === 'once') return `一次性 · ${formatTime(cadence.at)}`
      if (cadence.type === 'fixed') return `每 ${cadence.everyMinutes} 分钟`
      if (cadence.type === 'random') return `随机 ${cadence.minMinutes}~${cadence.maxMinutes} 分钟`
      return String(cadence.type)
    }

    /** 时区偏移 → ISO 后缀，例如 8 → "+08:00"。 */
    function offsetToIso(offset) {
      const n = Number(offset)
      const sign = n < 0 ? '-' : '+'
      return `${sign}${String(Math.abs(n)).padStart(2, '0')}:00`
    }

    /** epoch → 指定偏移下的 `YYYY-MM-DDTHH:MM`（给 datetime-local 回显用）。 */
    function epochToLocalInput(ms, offset) {
      const shifted = new Date(ms + Number(offset) * 3600_000)
      const pad = (n) => String(n).padStart(2, '0')
      return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
    }

    function buildCadence(draft) {
      if (draft.mode === 'once') {
        // datetime-local 给的是"该时区下的墙上时间"，补上偏移才是绝对时刻
        const local = String(draft.atLocal ?? '').trim()
        if (local) return { type: 'once', at: `${local}:00${offsetToIso(draft.utcOffset)}` }
        return { type: 'once', inMinutes: Number(draft.inMinutes) }
      }
      if (draft.mode === 'fixed') return { type: 'fixed', everyMinutes: Number(draft.everyMinutes) }
      return { type: 'random', minMinutes: Number(draft.minMinutes), maxMinutes: Number(draft.maxMinutes) }
    }

    /** 草稿表单的前端校验；返回 {字段: 说明}。 */
    function validateDraft(draft) {
      const errors = {}
      const intField = (raw, min, max, label) => {
        const text = String(raw ?? '').trim()
        if (text === '') return `请填写${label}`
        const n = Number(text)
        if (!Number.isInteger(n)) return `${label}必须是整数`
        if (n < min || n > max) return `${label}必须在 ${min}~${max} 之间`
        return null
      }

      if (draft.mode === 'once') {
        const local = String(draft.atLocal ?? '').trim()
        if (local) {
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) errors.atLocal = '时间格式不对，请用选择器重新选'
        } else {
          const message = intField(draft.inMinutes, 1, 43200, '分钟数')
          if (message) errors.inMinutes = message
        }
      } else if (draft.mode === 'fixed') {
        const message = intField(draft.everyMinutes, 1, 43200, '间隔')
        if (message) errors.everyMinutes = message
      } else {
        const minError = intField(draft.minMinutes, 1, 43200, '最小间隔')
        const maxError = intField(draft.maxMinutes, 1, 43200, '最大间隔')
        if (minError) errors.minMinutes = minError
        if (maxError) errors.maxMinutes = maxError
        if (!minError && !maxError && Number(draft.minMinutes) > Number(draft.maxMinutes)) {
          errors.minMinutes = '最小间隔不能大于最大间隔'
        }
      }

      const scratch = String(draft.scratch ?? '').trim()
      if (scratch.length === 0) errors.scratch = '说明不能为空'
      else if (scratch.length > 200) errors.scratch = '说明最多 200 字'
      return errors
    }

    function TickSettings() {
      const [config, setConfig] = React.useState(null)
      const [configErrors, setConfigErrors] = React.useState({})
      const [configStatus, setConfigStatus] = React.useState('')

      const [jobs, setJobs] = React.useState(null)
      const [stats, setStats] = React.useState(null)
      const [targetSessionId, setTargetSessionId] = React.useState(null)
      const [jobsError, setJobsError] = React.useState('')
      const [jobsStatus, setJobsStatus] = React.useState('')
      const [sessions, setSessions] = React.useState([])
      const [selectedSessionId, setSelectedSessionId] = React.useState(null)
      const [runtime, setRuntime] = React.useState(null)
      const [defaults, setDefaults] = React.useState(null)

      const [draft, setDraft] = React.useState(null)
      const [editingId, setEditingId] = React.useState(null)
      const [draftError, setDraftError] = React.useState('')
      const [draftErrors, setDraftErrors] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')

      /** 深比较（只为跳过无意义的重渲染，数据量很小）。 */
      const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

      const loadJobs = React.useCallback(async () => {
        const res = await fetch(JOBS_PATH, { cache: 'no-store' })
        const body = await res.json().catch(() => null)
        if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
        // 值没变就返回原引用，React 会跳过重渲染
        setJobs((current) => (sameJson(current, body.jobs ?? []) ? current : body.jobs ?? []))
        setTargetSessionId((current) => (current === (body.targetSessionId ?? null) ? current : body.targetSessionId ?? null))
        setStats((current) => (sameJson(current, body.stats ?? null) ? current : body.stats ?? null))
      }, [])

      React.useEffect(() => {
        let stopped = false
        fetch(CONFIG_PATH, { cache: 'no-store' })
          .then(async (res) => {
            const body = await res.json().catch(() => null)
            if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
            if (!stopped) {
              setConfig(body.config)
              setRuntime(body.runtime ?? null)
              setDefaults(body.defaults ?? null)
            }
          })
          .catch((err) => {
            if (!stopped) setLoadError(err instanceof Error ? err.message : String(err))
          })
        loadJobs().catch((err) => {
          if (!stopped) setJobsError(err instanceof Error ? err.message : String(err))
        })
        fetch(SESSIONS_PATH, { cache: 'no-store' })
          .then(async (res) => {
            const body = await res.json().catch(() => null)
            if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
            if (!stopped) setSessions(Array.isArray(body.sessions) ? body.sessions : [])
          })
          .catch((err) => {
            if (!stopped) setJobsError(err instanceof Error ? err.message : String(err))
          })
        return () => {
          stopped = true
        }
      }, [loadJobs])

      // 默认选中：上次用过的会话 → 否则最近活动的会话
      React.useEffect(() => {
        if (selectedSessionId) return
        const fallback = targetSessionId ?? sessions[0]?.sessionId ?? null
        if (fallback) setSelectedSessionId(fallback)
      }, [selectedSessionId, targetSessionId, sessions])

      // ── 参数 ────────────────────────────────────────────────────────────
      const setConfigField = React.useCallback((key, value) => {
        setConfig((current) => (current === null ? current : { ...current, [key]: value }))
        setConfigErrors((current) => {
          if (!current[key]) return current
          const next = { ...current }
          delete next[key]
          return next
        })
        setConfigStatus('')
      }, [])

      const saveConfig = React.useCallback(
        async (event) => {
          event.preventDefault()
          if (busy || config === null) return
          const clientErrors = validateConfig(config)
          if (Object.keys(clientErrors).length > 0) {
            setConfigErrors(clientErrors)
            setConfigStatus('有字段不合法，未提交')
            return
          }
          setBusy(true)
          setConfigErrors({})
          setConfigStatus('')
          try {
            // 时间字段统一补齐成 HH:MM 再提交
            const payload = { ...config }
            for (const field of FIELDS) {
              if (field.kind === 'time') payload[field.key] = normalizeHHMM(config[field.key]) ?? config[field.key]
            }
            const res = await fetch(CONFIG_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const body = await res.json().catch(() => null)
            if (!res.ok || !body?.ok) {
              setConfigErrors(body?.errors ?? { _: body?.error ?? `保存失败（HTTP ${res.status}）` })
              return
            }
            setConfig(body.config)
            setConfigStatus('已保存，新参数立即生效。')
          } catch (err) {
            setConfigErrors({ _: err instanceof Error ? err.message : String(err) })
          } finally {
            setBusy(false)
          }
        },
        [busy, config],
      )

      /**
       * 恢复出厂默认。默认值由宿主通过 GET /config 的 defaults 下发，
       * 前端不自己维护一份，避免两处定义漂移。
       */
      const resetConfig = React.useCallback(async () => {
        if (busy) return
        if (!defaults) {
          setConfigStatus('还没拿到出厂默认值，刷新页面再试')
          return
        }
        const canConfirm = typeof window !== 'undefined' && typeof window.confirm === 'function'
        if (canConfirm && !window.confirm('把所有运行参数恢复为出厂默认？\n\n任务和「错过的提醒」不会被删除。')) return

        setBusy(true)
        setConfigErrors({})
        setConfigStatus('')
        try {
          const res = await fetch(CONFIG_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaults),
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) {
            setConfigErrors(body?.errors ?? { _: body?.error ?? '恢复默认失败' })
            return
          }
          setConfig(body.config)
          setConfigStatus('已恢复出厂默认。')
        } catch (err) {
          setConfigErrors({ _: err instanceof Error ? err.message : String(err) })
        } finally {
          setBusy(false)
        }
      }, [busy, defaults])

      const clearAllJobs = React.useCallback(async () => {
        if (busy) return
        const canConfirm = typeof window !== 'undefined' && typeof window.confirm === 'function'
        if (
          canConfirm &&
          !window.confirm('确定删除【全部】任务吗？\n\n这会一次性删掉所有会话的定时任务，且无法撤销。\n只想删一个请用该行右侧的 ×。')
        ) {
          return
        }
        setBusy(true)
        setJobsError('')
        setJobsStatus('')
        try {
          const res = await fetch(JOBS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'clearAll' }),
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
          await loadJobs()
          setJobsStatus(`已删除全部任务（${body.removed ?? 0} 个）。`)
        } catch (err) {
          setJobsError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [busy, loadJobs])

      /** 只刷新 runtime，不动表单，避免覆盖用户正在编辑的输入。 */
      const refreshRuntime = React.useCallback(async () => {
        try {
          const res = await fetch(CONFIG_PATH, { cache: 'no-store' })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) return
          // 这里**故意不做**相等性判断：健康度是"墙钟函数"，
          // 只有重渲染才会重算「上次扫描 N 秒前」。
          // 若按"数据没变就不渲染"，插件真的停摆时 lastScanAt 不再变化 →
          // 永远不重渲染 → 告警冻在最后一个小值上，恰好漏掉最该报的场景。
          setRuntime(body.runtime ?? null)
        } catch {
          // 刷新失败不影响主流程
        }
      }, [])

      // 每 30 秒取一次数：
      //   runtime → 每次都更新（健康度需要随时间重算，否则停摆告警会冻住）
      //   jobs    → 带相等性判断（只有真变了才重渲染，列表本身不需要实时）
      // 挂载时的首次拉取仍然是"关掉再打开"的强制刷新路径。
      React.useEffect(() => {
        const timer = setInterval(() => {
          void refreshRuntime()
          loadJobs().catch(() => {})
        }, 30_000)
        return () => clearInterval(timer)
      }, [refreshRuntime, loadJobs])

      const clearMissed = React.useCallback(async () => {
        setBusy(true)
        setJobsError('')
        try {
          const res = await fetch(JOBS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'clearMissed' }),
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
          await refreshRuntime()
          setJobsStatus('错过提醒已确认。')
        } catch (err) {
          setJobsError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [refreshRuntime])

      // ── 任务 ────────────────────────────────────────────────────────────
      const startCreate = React.useCallback(() => {
        setEditingId(null)
        setDraftError('')
        setDraft({ ...emptyDraft })
      }, [])

      const startEdit = React.useCallback((job) => {
        const cadence = job.cadence ?? {}
        setEditingId(job.id)
        setDraftError('')
        setDraft({
          mode: cadence.type === 'once' ? 'once' : cadence.type === 'random' ? 'random' : 'fixed',
          inMinutes: '20',
          // 回显按默认偏移（UTC+8）折算成墙上时间
          atLocal: cadence.type === 'once' && typeof cadence.at === 'number'
            ? epochToLocalInput(cadence.at, '8')
            : '',
          utcOffset: '8',
          everyMinutes: String(cadence.everyMinutes ?? 30),
          minMinutes: String(cadence.minMinutes ?? 40),
          maxMinutes: String(cadence.maxMinutes ?? 46),
          scratch: job.scratch ?? '',
          importance: job.importance ?? 'normal',
        })
      }, [])

      /** 直接创建一条「主动聊天」任务，不弹表单（建错了删掉即可）。 */
      const createChatJob = React.useCallback(async () => {
        if (busy) return
        if (!selectedSessionId) {
          setJobsStatus('先在上面选一个「新建任务绑定的会话」。')
          return
        }
        setBusy(true)
        setJobsStatus('')
        setJobsError('')
        try {
          const res = await fetch(JOBS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'create',
              sessionId: selectedSessionId,
              cadence: CHAT_JOB_CADENCE,
              scratch: CHAT_JOB_SCRATCH,
              importance: 'normal',
            }),
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) {
            setJobsStatus(`创建失败：${body?.error ?? `HTTP ${res.status}`}`)
            return
          }
          await loadJobs()
          setJobsStatus('已创建主动聊天任务（随机 60~90 分钟）。')
        } catch (err) {
          setJobsStatus(`创建失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          setBusy(false)
        }
      }, [busy, selectedSessionId, loadJobs])

      const cancelDraft = React.useCallback(() => {
        setDraft(null)
        setEditingId(null)
        setDraftError('')
      }, [])

      const submitDraft = React.useCallback(
        async (event) => {
          event.preventDefault()
          if (busy || draft === null) return
          const fieldErrors = validateDraft(draft)
          if (Object.keys(fieldErrors).length > 0) {
            setDraftErrors(fieldErrors)
            setDraftError('有字段不合法，未提交')
            return
          }
          setDraftErrors({})
          setBusy(true)
          setDraftError('')
          setJobsStatus('')
          try {
            const payload = editingId
              ? {
                  action: 'update',
                  id: editingId,
                  patch: { scratch: draft.scratch, importance: draft.importance, cadence: buildCadence(draft) },
                }
              : {
                  action: 'create',
                  sessionId: selectedSessionId,
                  cadence: buildCadence(draft),
                  scratch: draft.scratch,
                  importance: draft.importance,
                }
            const res = await fetch(JOBS_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const body = await res.json().catch(() => null)
            if (!res.ok || !body?.ok) {
              setDraftError(body?.error ?? `保存失败（HTTP ${res.status}）`)
              return
            }
            await loadJobs()
            setJobsStatus(editingId ? '任务已更新。' : '任务已创建。')
            cancelDraft()
          } catch (err) {
            setDraftError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [busy, draft, editingId, loadJobs, cancelDraft, selectedSessionId],
      )

      const rebindJob = React.useCallback(
        async (job) => {
          if (!selectedSessionId) return
          setBusy(true)
          setJobsError('')
          try {
            const res = await fetch(JOBS_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'rebind', id: job.id, sessionId: selectedSessionId }),
            })
            const body = await res.json().catch(() => null)
            if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
            await loadJobs()
            setJobsStatus('已改绑到所选会话。')
          } catch (err) {
            setJobsError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [loadJobs, selectedSessionId],
      )

      const removeJob = React.useCallback(
        async (job) => {
          const label = job.scratch ? `「${job.scratch}」` : job.id
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm(`删除任务 ${label}？`)) return
          }
          setBusy(true)
          setJobsError('')
          try {
            const res = await fetch(JOBS_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'delete', id: job.id }),
            })
            const body = await res.json().catch(() => null)
            if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
            await loadJobs()
            setJobsStatus('任务已删除。')
          } catch (err) {
            setJobsError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [loadJobs],
      )

      if (loadError) {
        return h('div', { style: styles.wrap }, h('div', { style: styles.error }, `读取配置失败：${loadError}`))
      }

      try {
      // ── 渲染 ────────────────────────────────────────────────────────────
      const configSection =
        config === null
          ? h('div', { style: styles.status }, '正在读取配置…')
          : h(
              'form',
              { style: styles.section, onSubmit: saveConfig },
              h('h3', { style: styles.sectionTitle }, '运行参数'),
              h('div', { style: styles.intro }, '改动保存后立即生效，不需要重启插件。'),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('input', {
                  id: 'tick-enabled',
                  type: 'checkbox',
                  checked: config.enabled !== false,
                  disabled: busy,
                  onChange: (event) => setConfigField('enabled', event.target.checked),
                }),
                h('label', { htmlFor: 'tick-enabled', style: styles.label }, '启用 DSH-Tick'),
              ),
              h('div', { style: styles.hint },
                '关闭后所有任务暂停触发（任务本身保留），重新开启后继续。',
                ' 勾选/取消后需要点下方「保存参数」才生效——保存即生效，不需要重启或重载插件。'),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
                h('input', {
                  id: 'tick-allow-model',
                  type: 'checkbox',
                  checked: config.allowModelCreate !== false,
                  disabled: busy,
                  onChange: (event) => setConfigField('allowModelCreate', event.target.checked),
                }),
                h('label', { htmlFor: 'tick-allow-model', style: styles.label }, '允许模型自建任务'),
              ),
              h('div', { style: styles.hint },
                '取消勾选后，模型完全不能创建定时任务（调 tick_once / tick_repeat 会被拒绝）；',
                '你在这个页面建任务不受影响。同样需要点「保存参数」生效，保存后立即生效、不用重载。'),
              ...FIELDS.map((field) =>
                h(
                  'div',
                  { key: field.key, style: field.emphasis ? styles.rowEmphasis : styles.row },
                  h(
                    'label',
                    { style: styles.label, htmlFor: `tick-${field.key}` },
                    field.label,
                    field.emphasis ? h('span', { style: styles.badgeImportant }, '重要') : null,
                  ),
                  h('input', {
                    id: `tick-${field.key}`,
                    style: styles.shortInput,
                    value: config[field.key] ?? '',
                    disabled: busy,
                    ...(field.kind === 'time'
                      ? {
                          type: 'time',
                          // 原生时间控件：格式固定 HH:MM，不用手打冒号，8:9 会被浏览器补齐
                          step: 60,
                        }
                      : {
                          type: 'number',
                          // 允许小数的字段要用 decimal 键盘，否则手机打不出小数点
                          inputMode: field.step && field.step < 1 ? 'decimal' : 'numeric',
                          step: field.step ?? 1,
                          min: field.min,
                          max: field.max,
                        }),
                    onChange: (event) => setConfigField(field.key, event.target.value),
                  }),
                  h('div', { style: styles.hint }, field.hint),
                  configErrors[field.key] ? h('div', { style: styles.error }, configErrors[field.key]) : null,
                ),
              ),
              configErrors._ ? h('div', { style: styles.error }, String(configErrors._)) : null,
              h(
                'div',
                { style: styles.actions },
                h('button', { type: 'submit', style: styles.button, disabled: busy }, busy ? '保存中…' : '保存参数'),
                h('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: busy || !defaults,
                  onClick: resetConfig,
                }, '重置为默认'),
                configStatus ? h('span', { style: styles.status }, configStatus) : null,
              ),
            )

      // 数字输入框统一带上范围与步长，浏览器会直接拦掉字母
      const numberInput = (key, value, min, max) =>
        h('input', {
          type: 'number',
          inputMode: 'numeric',
          step: 1,
          min,
          max,
          style: styles.shortInput,
          value,
          disabled: busy,
          onChange: (e) => {
            setDraft({ ...draft, [key]: e.target.value })
            setDraftErrors((current) => {
              if (!current[key]) return current
              const next = { ...current }
              delete next[key]
              return next
            })
          },
        })

      const fieldError = (key) => (draftErrors[key] ? h('div', { style: styles.error }, draftErrors[key]) : null)

      const draftForm =
        draft === null
          ? null
          : h(
              'form',
              { style: styles.card, onSubmit: submitDraft },
              h('div', { style: styles.row },
                h('label', { style: styles.label }, '触发方式'),
                h(
                  'select',
                  {
                    style: styles.shortInput,
                    value: draft.mode,
                    disabled: busy,
                    onChange: (e) => setDraft({ ...draft, mode: e.target.value }),
                  },
                  h('option', { value: 'once' }, '一次性'),
                  h('option', { value: 'fixed' }, '固定间隔（重复）'),
                  h('option', { value: 'random' }, '随机间隔（重复）'),
                ),
              ),
              draft.mode === 'once'
                ? h(
                    'div',
                    { style: styles.grid },
                    h('div', { style: styles.row },
                      h('label', { style: styles.label }, '多少分钟后'),
                      numberInput('inMinutes', draft.inMinutes, 1, 43200),
                      h('div', { style: styles.hint }, '1~43200 的整数。和下面的绝对时间二选一。'),
                      fieldError('inMinutes'),
                    ),
                    h('div', { style: styles.row },
                      h('label', { style: styles.label }, '或指定绝对时间'),
                      h('input', {
                        type: 'datetime-local',
                        style: styles.input,
                        value: draft.atLocal,
                        disabled: busy,
                        onChange: (e) => {
                          setDraft({ ...draft, atLocal: e.target.value })
                          setDraftErrors((current) => {
                            if (!current.atLocal) return current
                            const next = { ...current }
                            delete next.atLocal
                            return next
                          })
                        },
                      }),
                      h('div', { style: styles.row },
                        h('label', { style: styles.label }, '时区'),
                        h(
                          'select',
                          {
                            style: styles.shortInput,
                            value: draft.utcOffset,
                            disabled: busy,
                            onChange: (e) => setDraft({ ...draft, utcOffset: e.target.value }),
                          },
                          // UTC-12 ~ UTC+14 是现实存在的时区范围
                          ...Array.from({ length: 27 }, (_, i) => i - 12).map((n) =>
                            h('option', { key: n, value: String(n) }, `UTC${n >= 0 ? '+' : ''}${n}`),
                          ),
                        ),
                      ),
                      h('div', { style: styles.hint }, '用选择器选时间即可，默认按 UTC+8。'),
                      fieldError('atLocal'),
                    ),
                  )
                : draft.mode === 'fixed'
                  ? h('div', { style: styles.row },
                      h('label', { style: styles.label }, '每隔多少分钟'),
                      numberInput('everyMinutes', draft.everyMinutes, 1, 43200),
                      h('div', { style: styles.hint }, '每次触发后，从这一刻起再等这么久。1~43200 的整数。'),
                      fieldError('everyMinutes'),
                    )
                  : h('div', { style: styles.grid },
                      h('div', { style: styles.row },
                        h('label', { style: styles.label }, '每次最小间隔（分钟）'),
                        numberInput('minMinutes', draft.minMinutes, 1, 43200),
                        fieldError('minMinutes'),
                      ),
                      h('div', { style: styles.row },
                        h('label', { style: styles.label }, '每次最大间隔（分钟）'),
                        numberInput('maxMinutes', draft.maxMinutes, 1, 43200),
                        fieldError('maxMinutes'),
                      ),
                      h('div', { style: { ...styles.hint, gridColumn: '1 / -1' } },
                        '重复触发：每次触发后重新抽一个间隔。比如 40~46 表示每 40~46 分钟一次。'),
                    ),
              h('div', { style: styles.row },
                h('label', { style: styles.label }, '任务说明（scratch）'),
                h('textarea', {
                  style: { ...styles.input, minHeight: '60px', resize: 'vertical' },
                  value: draft.scratch,
                  disabled: busy,
                  maxLength: 200,
                  placeholder: '写给未来自己的话，触发时会原样注入',
                  onChange: (e) => setDraft({ ...draft, scratch: e.target.value }),
                }),
                h('div', { style: styles.hint }, `${String(draft.scratch).length} / 200 字`),
              ),
              h('div', { style: styles.row },
                h('label', { style: styles.label }, '重要性'),
                h('select', {
                  style: styles.shortInput,
                  value: draft.importance,
                  disabled: busy,
                  onChange: (e) => setDraft({ ...draft, importance: e.target.value }),
                },
                h('option', { value: 'normal' }, '普通'),
                h('option', { value: 'important' },
                  draft.mode === 'once' ? '重要（错过会补告知）' : '重要（豁免窗口，错过会提醒）')),
              ),
              draftError ? h('div', { style: styles.error }, draftError) : null,
              h('div', { style: styles.actions },
                h('button', { type: 'submit', style: styles.button, disabled: busy },
                  busy ? '保存中…' : editingId ? '保存修改' : '创建任务'),
                h('button', { type: 'button', style: styles.button, disabled: busy, onClick: cancelDraft }, '取消'),
              ),
            )

      // 任务行里只放短编号（A/B/C），全名放图例——长标题撑不坏行内布局。
      // 只有 1 个来源会话时编号和图例都不显示（无歧义就不占空间）。
      //
      // 注意：这段必须在 jobRows 之前求值。jobs.map() 是立即执行的，
      // 若把 multiSession 声明放在后面，有任务时会踩到暂时性死区
      // （Cannot access 'multiSession' before initialization），
      // 表现为「一建任务，设置页整块空白」——0 个任务时不报错，所以很隐蔽。
      const jobSessionIds = []
      for (const job of jobs ?? []) {
        const id = job.boundSessionId
        if (id && !jobSessionIds.includes(id)) jobSessionIds.push(id)
      }
      const multiSession = jobSessionIds.length > 1
      const codeOf = (id) => {
        const index = jobSessionIds.indexOf(id)
        if (index < 0) return null
        return index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`
      }
      const sessionName = (id) => {
        if (!id) return '未绑定'
        const found = (sessions ?? []).find((item) => item.sessionId === id)
        if (found) return found.title || found.cwd || String(id).slice(0, 8)
        return `${String(id).slice(0, 8)}…（不可见）`
      }

      const jobRows =
        jobs === null
          ? h('div', { style: styles.status }, '正在读取任务…')
          : jobs.length === 0
            ? h('div', { style: styles.status }, '还没有任务。点下面的「新建任务」，或在聊天里让我建一个。')
            : jobs.map((job) =>
                h(
                  'div',
                  { key: job.id, style: styles.item },
                  h(
                    'div',
                    { style: styles.itemMain },
                    h('div', { style: styles.itemTitle },
                      job.scratch || '（无说明）',
                      job.importance === 'important'
                        ? h('span', { style: styles.badge }, '重要')
                        : null,
                      job.enabled === false ? h('span', { style: styles.badge }, '已停用') : null,
                      job.unreachable ? h('span', { style: styles.badge }, '会话不可达') : null),
                    h('div', { style: styles.itemMeta },
                      `${describeCadence(job.cadence)} · 下次 ${formatTime(job.nextDueAt)} · ${job.origin === 'admin' ? '你设的' : '它自主设的'}${multiSession && codeOf(job.boundSessionId) ? ` · 会话 ${codeOf(job.boundSessionId)}` : ''}${Number(runtime?.blockedPerJob?.[job.id] ?? 0) > 0 ? ` · 今日错过 ${Number(runtime.blockedPerJob[job.id])} 次` : ''}`),
                  ),
                  job.unreachable && selectedSessionId
                    ? h('button', {
                        type: 'button',
                        style: styles.smallButton,
                        disabled: busy,
                        onClick: () => rebindJob(job),
                      }, '改绑到所选会话')
                    : null,
                  h('button', { type: 'button', style: styles.smallButton, disabled: busy, onClick: () => startEdit(job) }, '编辑'),
                  h('button', { type: 'button', style: styles.smallButton, disabled: busy, onClick: () => removeJob(job) }, '×'),
                ),
              )

      const missedItems = Array.isArray(runtime?.missed) ? runtime.missed : []
      const missedSection =
        missedItems.length === 0
          ? null
          : h(
              'div',
              { style: styles.section },
              h('h3', { style: styles.sectionTitle }, '错过的提醒'),
              h('div', { style: styles.intro },
                '这些任务到期时没能触发。重要任务已经补过一次告知，这里留个记录；确认后可以清空。'),
              h(
                'div',
                { style: styles.list },
                ...missedItems.map((item, index) =>
                  h(
                    'div',
                    { key: `${item.id ?? 'x'}-${item.dueAt ?? index}-${index}`, style: styles.item },
                    h(
                      'div',
                      { style: styles.itemMain },
                      h('div', { style: styles.itemTitle },
                        item.dropReason === 'queue_full'
                          ? (item.note ?? '（列表已满，较早的记录被挤出）')
                          : (item.scratch || item.id || '（无说明）')),
                      item.dropReason === 'queue_full'
                        ? null
                        : h('div', { style: styles.itemMeta },
                            item.dropReason === 'unreachable'
                              ? `目标会话已不可达，任务被自动移除 · 原定 ${formatTime(item.dueAt)}`
                              : `原定 ${formatTime(item.dueAt)} · 迟到 ${item.lateMin ?? '?'} 分钟`),
                    ),
                  ),
                ),
              ),
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: clearMissed },
                '知道了，清空'),
            )

      const jobsSection = h(
        'div',
        { style: styles.section },
        h('h3', { style: styles.sectionTitle }, '任务'),
        // I3 健康度：自检环停摆时，这里是唯一的可见信号（否则只能靠"任务怎么不触发了"发现）
        (() => {
          const lastScanAt = Number(runtime?.lastScanAt) || 0
          const intervalMs = Math.max(1, Number(config?.scanIntervalMin) || 1) * 60_000
          if (!lastScanAt) {
            return h('div', { style: styles.status }, '上次扫描：还没有记录（插件刚启动或已停用）')
          }
          const age = Math.max(0, Date.now() - lastScanAt)
          const text =
            age < 60_000 ? `${Math.round(age / 1000)} 秒前` : `${Math.round(age / 60_000)} 分钟前`
          const style =
            age > intervalMs * 10 ? styles.statusDanger : age > intervalMs * 3 ? styles.statusWarn : styles.status
          return h('div', { style }, `上次扫描：${text}${age > intervalMs * 3 ? '（明显偏慢，检查插件是否还在运行）' : ''}`)
        })(),
        stats
          ? h('div', { style: styles.status },
              `任务 ${stats.total} / ${stats.totalMax}　·　模型自建重要任务 ${stats.important} / ${stats.importantMax}　·　今日周期任务执行 ${runtime?.ranTodayRecurring ?? 0} / ${runtime?.maxRunsPerDay ?? 30}　·　错过 ${runtime?.blockedToday ?? 0}`)
          : null,
        // 多会话时用编号 + 图例。每条**单行截断**（悬停看全名），
        // 否则长标题会把图例撑成好几行，把任务列表挤下去。
        multiSession
          ? h('div', { style: { ...styles.hint, display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline' } },
              h('span', { key: 'label' }, '来源会话：'),
              ...jobSessionIds.map((id) =>
                h('span', {
                  key: id,
                  title: sessionName(id), // 悬停看完整标题
                  style: { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, `${codeOf(id)} = ${sessionName(id)}`)))
          : null,
        h('div', { style: { ...styles.hint, whiteSpace: 'pre-line' } },
          '任务数量上限就是真实生效的值；你在本页建的重要任务不计入「模型自建」。',
          '\n周期任务（固定/随机间隔）过期不会产生错过提醒——错过的那一轮直接顺延到下一次，只留一行日志；',
          '\n会进「错过的提醒」的只有：重要的一次性任务超容忍，以及因目标会话不可达被自动移除的任务。'),
        h('div', { style: styles.row },
          h('label', { style: styles.label, htmlFor: 'tick-session' }, '新建任务绑定的会话'),
          h('select', {
            id: 'tick-session',
            style: styles.input,
            value: selectedSessionId ?? '',
            disabled: busy || sessions.length === 0,
            onChange: (e) => setSelectedSessionId(e.target.value || null),
          },
            sessions.length === 0 ? h('option', { value: '' }, '（没有可用会话）') : null,
            ...sessions.map((s) => h('option', { key: s.sessionId, value: s.sessionId }, sessionLabel(s))),
          ),
          h('div', { style: styles.hint }, '只影响「新建任务」时绑给谁；已有任务不受影响。列表只含可见会话，已归档的不在其中。'),
        ),
        jobsError ? h('div', { style: styles.error }, jobsError) : null,
        h('div', { style: styles.list }, jobRows),
        jobsStatus ? h('div', { style: styles.status }, jobsStatus) : null,
        draftForm,
        draft === null
          ? h('button', { type: 'button', style: styles.button, onClick: startCreate }, '新建任务')
          : null,
        draft === null
          ? h('button', {
              type: 'button',
              style: styles.smallButton,
              disabled: busy || sessions.length === 0,
              onClick: createChatJob,
            }, '新建主动聊天任务')
          : null,
        draft === null
          ? h('div', { style: styles.hint },
              '随机 60~90 分钟给它一次主动开口的机会；点一下直接建，建错了删掉即可。')
          : null,
        jobs && jobs.length > 0
          ? h('button', {
              type: 'button',
              style: styles.smallButton,
              disabled: busy,
              onClick: clearAllJobs,
            }, '清除全部任务')
          : null,
      )

      return h('div', { style: styles.wrap }, configSection, h('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border, #e5e7eb)', margin: 0 } }), missedSection, jobsSection)
      } catch (error) {
        // 单组件降级：渲染异常绝不能把整个设置页干掉（曾经就是这样白屏的）。
        // 这里如实显示错误信息，方便用户截图反馈。
        console.error('[dsh-tick] render failed', error)
        return h(
          'div',
          { style: styles.wrap },
          h('div', { style: styles.error }, `DSH-Tick 设置页渲染失败：${error?.message ?? error}`),
          h('div', { style: styles.hint }, '任务和设置本身没有损坏，重新加载页面通常可以恢复。'),
        )
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'tick', order: 7, label: 'DSH-Tick' },
              TickSettings,
            ),
          )
        } catch (err) {
          // fail-soft：单个分组的异常不能影响整个设置页
          console.error('[dsh-tick] settings section registration failed', err)
        }
      },
    }
  },
})
