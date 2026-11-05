/** 记忆页提供筛选、选中记录的详情，以及纠正或忘记操作。 */
import { useEffect, useRef, useState } from 'react'
import type { ChatSourceLocation } from '../../shared/chat-history'
import type { ManagedMemory, MemoryChange, MemoryDeletionPreview, MemoryManagementOverview, MemoryScope } from '../../shared/memory-management'
import ConfirmationDialog from '../settings/ConfirmationDialog'
import styles from './MemoryPage.module.css'

const kinds: Record<ManagedMemory['kind'], string> = {
  fact: '事实', preference: '偏好', episode: '共同经历', temporary: '近期状态', interaction_request: '相处方式',
}
const statuses = { active: '有效', superseded: '已替代', expired: '已过期' }
const statusFilters = ['all', 'active', 'superseded', 'expired', 'forgotten'] as const
const memoriesPerPage = 6
const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const failureMessages: Record<string, string> = {
  STALE_REVISION: '这条记忆刚刚有变化，已重新读取。请核对后再操作。',
  NOT_FOUND: '这条记忆已找不到，请重新读取列表。',
  MEMORY_CLEANUP_FAILED: '记忆已经更新，但本地清理未完成。请重试清理。',
  MEMORY_CLEANUP_PENDING: '本地正在清理上一项变更，请稍后再试。',
  SOURCE_PREVIEW_CHANGED: '相关原话有变化，请重新查看删除范围。',
}
const sourceRoles: Record<string, string> = { user: '你', assistant: '角色', proactive: '主动问候' }
const origins: Record<string, string> = { user_edit: '用户编辑', user_explicit: '用户明确交代', conversation_event: '聊天整理' }
const iconPaths = {
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5',
  share: 'M7 12l10-6M7 12l10 6M7 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm14-7a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 6 0 0 1 16 0v2H4Z',
  heart: 'M20 5a5 5 0 0 0-7 0l-1 1-1-1a5 5 0 0 0-7 7l8 8 8-8a5 5 0 0 0 0-7Z',
  calendar: 'M4 6h16v15H4V6Zm4-3v6m8-6v6M4 11h16',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v6l4 2',
  message: 'M4 5h16v12H9l-5 4V5Zm4 5h8m-8 3h5',
  note: 'M6 3h12v18H6V3Zm3 5h6m-6 4h6m-6 4h4',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v5m0-8v.1',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  link: 'M13 4h7v7m0-7-9 9m5 0v7H4V8h7',
  trash: 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3m-12 0h14v11H5V10Zm7 4v3',
  check: 'm5 12 5 5 9-10',
  warning: 'M12 5v9m0 3v.2',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
}
const kindIcons: Record<ManagedMemory['kind'], keyof typeof iconPaths> = {
  fact: 'person', preference: 'heart', episode: 'calendar', temporary: 'clock', interaction_request: 'message',
}

/** 图标旁边已有文字，屏幕阅读器只读按钮或列表本身的名字。 */
function MemoryIcon({ name }: { name: keyof typeof iconPaths }) {
  return <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true"><path d={iconPaths[name]} /></svg>
}

type Selection = { memory: ManagedMemory; action: 'correct' | 'forget' }
type DeletionReview = 'loading' | 'failed' | MemoryDeletionPreview | null
type ForgetFeedback = { phase: 'working' | 'failed' | 'done'; title: string; message: string }

interface MemoryPageProps {
  characterId?: string
  characterName?: string
  onHistoryChanged: () => void
  onOpenSource: (source: ChatSourceLocation) => void
}

/** 用替代关系串起新旧值，不靠文字猜测哪些记录属于同一次改动。 */
function memoryHistory(memory: ManagedMemory, memories: ManagedMemory[]): ManagedMemory[] {
  const versions = new Map(memories.map((row) => [row.id, row]))
  const successors = new Map<string, ManagedMemory[]>()
  for (const row of memories) {
    if (!row.supersedesId) continue
    const newer = successors.get(row.supersedesId) ?? []
    newer.push(row)
    successors.set(row.supersedesId, newer)
  }
  const history = new Set<ManagedMemory>([versions.get(memory.id) ?? memory])
  // 往两个方向找，用户点中旧值时也看得见后续版本。已看过的记录只加入一次。
  for (const row of history) {
    const previous = row.supersedesId && versions.get(row.supersedesId)
    if (previous) history.add(previous)
    for (const newer of successors.get(row.id) ?? []) history.add(newer)
  }
  return [...history].sort((a, b) => b.validFrom - a.validFrom)
}

/** 展示选中记录的详情与历史，操作目标始终是当前选中的记录。 */
function MemoryDetail({ memory, memories, privateScope, busy, onSelect, onOpenSource }: {
  memory: ManagedMemory
  memories: ManagedMemory[]
  privateScope: string
  busy: boolean
  onSelect: (memory: ManagedMemory, action: Selection['action']) => void
  onOpenSource: MemoryPageProps['onOpenSource']
}) {
  const history = memoryHistory(memory, memories)
  const previous = history.find((row) => row.id === memory.supersedesId)
  return <aside className={styles.detail} aria-labelledby="memory-detail-title">
    <header className={styles.detailHeader}>
      <h2 id="memory-detail-title">记忆详情</h2>
      <span className={styles.state} data-state={memory.status}>{statuses[memory.status]}</span>
    </header>
    <div className={styles.detailBody} tabIndex={0} role="region" aria-label="记忆详情内容">
      <p className={styles.content}>{memory.content}</p>
      <div className={styles.tags}>
        <span className={styles.kind}>{kinds[memory.kind]}</span>
        <span className={styles.scopeTag}>{memory.scope === 'global' ? '用户明确共享' : privateScope}</span>
      </div>
      <dl className={styles.metadata}>
        <dt>记录时间</dt><dd>{timeFormat.format(memory.validFrom)}</dd>
        <dt>更新时间</dt><dd>{timeFormat.format(memory.updatedAt)}</dd>
        <dt>记录方式</dt><dd>{origins[memory.origin] ?? '已保存'}</dd>
        {previous ? <><dt>替代了</dt><dd>{previous.content}</dd></> : null}
        {memory.expiresAt !== null ? <><dt>有效期至</dt><dd>{timeFormat.format(memory.expiresAt)}</dd></> : null}
      </dl>
      <section className={styles.detailSection}>
        <h3>来源</h3>
        {memory.sources.length ? <div className={styles.sources}>
          {memory.sources.map((source) => <blockquote key={source.id}>
            <p>{source.content}</p>
            <footer className={styles.sourceFooter}>
              <span>{timeFormat.format(source.createdAt)}{source.excluded ? ' · 已停止用作聊天背景' : ''}</span>
              {source.location ? <button type="button" className={styles.button} disabled={busy}
                onClick={() => { if (source.location) onOpenSource(source.location) }}>跳到原聊天 <MemoryIcon name="link" /></button> : null}
            </footer>
          </blockquote>)}
        </div> : <p className={styles.date}>无关联聊天原话</p>}
      </section>
      <section className={styles.detailSection}>
        <h3>历史变化</h3>
        <ol className={styles.timeline}>
          {history.map((row) => <li key={row.id}>
            <time dateTime={new Date(row.validFrom).toISOString()}>{timeFormat.format(row.validFrom)}</time>
            <p>{row.supersedesId ? '更新为' : '首次记录'} · {row.content}</p>
          </li>)}
        </ol>
      </section>
    </div>
    <div className={`${styles.actions} ${styles.detailActions}`}>
      {memory.status === 'active' ? <button type="button" className={styles.primary} disabled={busy}
        onClick={() => onSelect(memory, 'correct')}>编辑纠正</button> : null}
      <button type="button" className={styles.danger} disabled={busy} onClick={() => onSelect(memory, 'forget')}>
        <MemoryIcon name="trash" />忘记此信息…
      </button>
    </div>
  </aside>
}

/**
 * 渲染正式角色的记忆手记，管理操作通过应用的受信通道交给后台。
 * @param props 当前角色用于显示；操作成功或待清理时通知聊天页重读历史
 * @returns 列表、来源和确认框
 */
export default function MemoryPage({ characterId, characterName, onHistoryChanged, onOpenSource }: MemoryPageProps) {
  const [overview, setOverview] = useState<MemoryManagementOverview | null>(null)
  const [filter, setFilter] = useState<typeof statusFilters[number]>('all')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [listPage, setListPage] = useState(0)
  const [forgottenIndex, setForgottenIndex] = useState(0)
  const [sharedView, setSharedView] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createScope, setCreateScope] = useState<MemoryScope | null>(null)
  const [createRequestId, setCreateRequestId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [deletionReview, setDeletionReview] = useState<DeletionReview>(null)
  const [draft, setDraft] = useState('')
  const [conflictChoice, setConflictChoice] = useState<'keep' | 'replace' | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [forgetFeedback, setForgetFeedback] = useState<ForgetFeedback | null>(null)
  const readGeneration = useRef(0)
  const saving = useRef(false)
  const previousRequest = useRef<{ key: string; id: string } | null>(null)

  /** 旧窗口请求晚回来时，不能把刚更新的记录盖成旧版本。 */
  async function read() {
    const current = ++readGeneration.current
    setLoading(true)
    try {
      const response = await window.appApi?.getMemories()
      if (!response?.ok || !response.data) throw new Error('READ_FAILED')
      if (current === readGeneration.current) {
        setOverview(response.data)
        return response.data
      }
    } catch {
      if (current === readGeneration.current) setError('暂时无法读取记忆，请重试。')
    } finally {
      if (current === readGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    setError(null)
    void read()
    return () => { readGeneration.current++ }
  }, [characterId])

  /** 打开确认框时固定记忆修订号。保存前即使后台修改了它，也不能把别人更新覆盖掉。 */
  function select(memory: ManagedMemory, action: Selection['action']): void {
    setSelection({ memory, action })
    setDeletionReview(null)
    setDraft(memory.content)
    setConflictChoice(null)
    setNotice(null)
    setForgetFeedback(null)
    setError(null)
    previousRequest.current = null
  }

  /** 新资料每次都从空白范围开始，由用户明确选择可使用的角色。 */
  function openCreate(): void {
    setCreateOpen(true)
    setCreateScope(null)
    setCreateRequestId(null)
    setDraft('')
    setNotice(null)
    setError(null)
  }

  /** 一旦提交，重试继续使用原编号和范围，防止同一份资料被保存两次。 */
  async function saveMaterial(): Promise<void> {
    const content = draft.trim()
    if (!createScope || !content || saving.current) return
    const requestId = createRequestId ?? crypto.randomUUID()
    saving.current = true
    setCreateRequestId(requestId)
    setBusy(true)
    setError(null)
    try {
      const result = await window.appApi?.changeMemory({ action: 'create', content, scope: createScope, requestId })
      if (result?.ok && result.data?.receipt) {
        setCreateOpen(false)
        setNotice(createScope === 'global' ? '共享资料已保存。' : '已保存为当前角色的私有记忆。')
      } else {
        setError(failureMessages[result?.code ?? ''] ?? '暂时无法确认保存结果，请重试。')
      }
    } catch {
      setError('暂时无法确认保存结果，请重试。')
    } finally {
      onHistoryChanged()
      await read()
      saving.current = false
      setBusy(false)
    }
  }

  /** 第一次点击只向后台读名单。用户看完完整消息后才能确认删除。 */
  async function reviewDeletion(): Promise<void> {
    if (!selection || deletionReview === 'loading') return
    const { id, revision } = selection.memory
    setDeletionReview('loading')
    setError(null)
    try {
      const result = await window.appApi?.previewMemoryDeletion({ memoryId: id, expectedRevision: revision })
      if (result?.ok && result.data) {
        setDeletionReview(result.data)
        return
      }
      if (result?.code === 'STALE_REVISION' || result?.code === 'NOT_FOUND') {
        setSelection(null)
        setError(failureMessages[result.code])
        await read()
        return
      }
    } catch { /* 读取失败仍停在确认框，用户可以重读。 */ }
    setDeletionReview('failed')
    setError('暂时无法读取将删除的原话，请重试。')
  }

  /** 同一按钮的重试沿用请求编号；改文案或换删除范围时属于另一项操作。 */
  async function save(deletion?: MemoryDeletionPreview): Promise<void> {
    if (!selection || saving.current) return
    const { memory, action } = selection
    const content = draft.trim()
    if (action === 'correct' && (!content || content === memory.content)) return
    const key = JSON.stringify([memory.id, memory.revision, action, action === 'correct' ? content : deletion?.sourceFingerprint])
    if (previousRequest.current?.key !== key) previousRequest.current = { key, id: crypto.randomUUID() }
    const base = { memoryId: memory.id, expectedRevision: memory.revision, requestId: previousRequest.current.id }
    const change: MemoryChange = action === 'correct' ? { ...base, action, content } : {
      ...base, action, deleteSources: deletion !== undefined, sourceFingerprint: deletion?.sourceFingerprint,
    }
    saving.current = true
    setBusy(true)
    setError(null)
    if (action === 'forget') {
      // 刚提交的内容可能已经删了，等后台重读结果前不再渲染旧列表和确认原话。
      readGeneration.current++
      setOverview(null)
      setForgetFeedback({
        phase: 'working', title: '正在处理',
        message: deletion ? '正在清理记忆、相关聊天原文和本地缓存…' : '正在清理记忆和本地缓存…',
      })
    }
    let reloaded = false
    try {
      const result = await window.appApi?.changeMemory(change)
      if (result?.ok && result.data?.receipt) {
        const receipt = result.data.receipt
        const persona = receipt.personaContainsContent ? ' 角色设定里还有相同文字，可以在角色设置里修改。' : ''
        if (action === 'correct') setNotice(sharedView ? '共享资料已更新。' : '记忆已纠正，原来的值可在「已替代」中查看。')
        else setForgetFeedback({
          phase: 'done', title: sharedView ? '共享资料已删除' : receipt.removedSources ? '已忘记，相关聊天原文已删除' : '已忘记此信息',
          message: (receipt.removedSources ? `已删除 ${receipt.removedSources} 条聊天原文，本地缓存已清理。`
            : deletion ? '本地缓存已清理。该记忆没有关联原话。' : '本地缓存已清理，聊天原文仍保留。') + persona,
        })
        setSelection(null)
        setDeletionReview(null)
      } else {
        const code = result?.code ?? ''
        if (action === 'correct' && code === 'STALE_REVISION') {
          // 冲突时保留草稿，但只允许针对最新有效版本重新选择。
          const fresh = await read()
          reloaded = true
          const latest = fresh && memoryHistory(memory, fresh.memories).find((row) =>
            row.status === 'active' && (row.id !== memory.id || row.revision !== memory.revision))
          if (latest) {
            setSelection({ memory: latest, action })
            setConflictChoice('keep')
          } else {
            setSelection(null)
            setError('这条记忆已过期、被忘记或无法重新读取。请刷新列表后核对。')
          }
        } else if (action === 'forget' && !['STALE_REVISION', 'NOT_FOUND', 'SOURCE_PREVIEW_CHANGED'].includes(code)) {
          setForgetFeedback({ phase: 'failed', title: '尚未完成忘记',
            message: failureMessages[code] ?? '暂时无法确认清理结果，请重试。' })
        } else {
          setForgetFeedback(null)
          setError(failureMessages[code] ?? '暂时无法确认操作结果，请重试。')
          if (['MEMORY_CLEANUP_FAILED', 'STALE_REVISION', 'NOT_FOUND'].includes(code)) setSelection(null)
          if (code === 'SOURCE_PREVIEW_CHANGED') setDeletionReview('failed')
        }
      }
    } catch {
      if (action === 'forget') setForgetFeedback({ phase: 'failed', title: '尚未完成忘记', message: '暂时无法确认清理结果，请重试。' })
      else setError('暂时无法确认操作结果，请重试。')
    } finally {
      onHistoryChanged()
      if (!reloaded) await read()
      saving.current = false
      setBusy(false)
    }
  }

  /** 关闭结果时丢掉本次确认内容，已清理的正文不会在下一次打开时出现。 */
  function closeForgetFeedback(): void {
    if (busy) return
    setForgetFeedback(null)
    setSelection(null)
    setDeletionReview(null)
    setDraft('')
  }

  /** 清理可以单独重试，已经保存的纠正和删除无需再执行一遍。 */
  async function retryCleanup(): Promise<void> {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await window.appApi?.retryMemoryCleanup()
      if (!result?.ok) throw new Error('MEMORY_CLEANUP_FAILED')
      setNotice('本地清理完成，可以继续聊天。')
    } catch {
      setError(failureMessages.MEMORY_CLEANUP_FAILED)
    } finally {
      onHistoryChanged()
      await read()
      saving.current = false
      setBusy(false)
    }
  }

  const memories = overview?.memories ?? []
  const forgotten = overview?.forgottenAt ?? []
  const showingForgotten = filter === 'forgotten'
  const keyword = query.trim().toLocaleLowerCase('zh-CN')
  const counts = { all: memories.length, active: 0, superseded: 0, expired: 0, forgotten: forgotten.length }
  const shown = memories.filter((memory) => {
    counts[memory.status]++
    return (filter === 'all' || memory.status === filter) &&
      (category === 'all' || memory.kind === category) &&
      memory.content.toLocaleLowerCase('zh-CN').includes(keyword)
  })
  const total = showingForgotten ? forgotten.length : shown.length
  const lastPage = Math.max(0, Math.ceil(total / memoriesPerPage) - 1)
  const currentPage = Math.min(listPage, lastPage)
  const pageStart = currentPage * memoriesPerPage
  const pageEnd = pageStart + memoriesPerPage
  const visibleMemories = shown.slice(pageStart, pageEnd)
  const visibleForgotten = forgotten.slice(pageStart, pageEnd)
  const selectedForgottenIndex = forgottenIndex >= pageStart && forgottenIndex < Math.min(pageEnd, forgotten.length)
    ? forgottenIndex : pageStart
  const forgottenTime = forgotten[selectedForgottenIndex]
  const detail = visibleMemories.find((memory) => memory.id === detailId) ?? visibleMemories[0]
  const shared = memories.filter((memory) => memory.scope === 'global' && memory.status === 'active')
  const privateScope = characterName ? `仅${characterName}可用` : '仅当前角色可用'
  const deletion = typeof deletionReview === 'object' ? deletionReview : null
  const dialogBusy = busy || deletionReview === 'loading'
  const hasDetail = !sharedView && (showingForgotten ? forgottenTime !== undefined : !!detail)

  return <section className={styles.page} aria-labelledby="memory-title">
    <div className={styles.workspace} data-detail={hasDetail}>
      <div className={styles.inventory} data-shared={sharedView}>
        <header className={styles.header}>
          <div className={styles.headerTitle}>
            <h1 id="memory-title">{sharedView ? '共享资料' : '记忆'}</h1>
            <p>{sharedView ? '只共享你明确指定的资料。' : '查看她记住了什么，也可以纠正或忘记。'}</p>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy}
              onClick={() => { setSharedView(!sharedView); setNotice(null) }}>
              <MemoryIcon name={sharedView ? 'left' : 'share'} />{sharedView ? '返回记忆' : '共享资料'}
            </button>
            {sharedView ? <button type="button" className={styles.primary} disabled={busy || loading}
              onClick={openCreate}><MemoryIcon name="plus" />新增共享资料</button> : null}
          </div>
        </header>
        {!sharedView ? <>
          <div className={styles.search}>
            <div className={styles.searchBox}>
              <MemoryIcon name="search" />
              <input type="search" aria-label="搜索记忆内容" placeholder="搜索记忆内容" disabled={showingForgotten}
                value={showingForgotten ? '' : query} onChange={(event) => { setQuery(event.target.value); setListPage(0) }} />
            </div>
            <select aria-label="记忆类别" value={showingForgotten ? 'all' : category} disabled={showingForgotten}
              onChange={(event) => { setCategory(event.target.value); setListPage(0) }}>
              <option value="all">全部类别</option>
              {Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
            </select>
          </div>
          <div className={styles.filters} role="group" aria-label="记忆状态">
            {statusFilters.map((status) => <button key={status} type="button" aria-pressed={filter === status}
              onClick={() => { setFilter(status); setListPage(0) }}>
              {status === 'all' ? '全部' : status === 'forgotten' ? '已忘记' : statuses[status]} <span>{counts[status]}</span>
            </button>)}
            <button className={styles.refresh} type="button" disabled={loading || busy}
              onClick={() => { setError(null); void read() }}>刷新</button>
          </div>
        </> : null}
        <div className={styles.scroll} aria-busy={loading || busy}>
          {notice ? <p className={styles.notice} data-shared={sharedView} role="status">
            {sharedView ? <span className={styles.successBadge}><MemoryIcon name="check" /></span> : null}{notice}
          </p> : null}
          {error && !selection && !createOpen ? <p className={styles.error} role="alert">{error}</p> : null}
          {overview?.cleanupPending ? <div className={styles.cleanup}>
            <p>还有本地缓存待清理，相关聊天会暂时停用。</p>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void retryCleanup()}>重试清理</button>
          </div> : null}
          {loading && !overview ? <p role="status" className={styles.empty}>正在读取记忆…</p> : null}
          {!loading && overview && sharedView && shared.length === 0 ? <div className={styles.empty}>
            <h2>还没有共享资料</h2>
            <p>你明确共享的资料会出现在这里。</p>
          </div> : null}
          {sharedView && shared.length > 0 ? <>
            <div className={`${styles.tableHeading} ${styles.sharedHeading}`} aria-hidden="true">
              <span>内容</span><span>共享范围</span><span>更新时间</span><span>操作</span>
            </div>
            <ol className={styles.list} aria-label="共享资料列表">
              {shared.map((memory) => <li key={memory.id} className={styles.sharedItem}>
                <span className={styles.rowContent}><MemoryIcon name="note" /><span>{memory.content}</span></span>
                <span className={styles.scopeTag}>用户明确共享</span>
                <time className={styles.date} dateTime={new Date(memory.updatedAt).toISOString()}>{timeFormat.format(memory.updatedAt)}</time>
                <div className={styles.actions}>
                  <button type="button" className={styles.button} disabled={busy} onClick={() => select(memory, 'correct')}>编辑</button>
                  <button type="button" className={styles.danger} disabled={busy} onClick={() => select(memory, 'forget')}>删除…</button>
                </div>
              </li>)}
            </ol>
          </> : null}
          {!sharedView && showingForgotten && !loading && overview && forgottenTime === undefined
            ? <div className={styles.empty}><h2>还没有删除记录</h2><p>忘记资料后，这里只会留下操作时间。</p></div> : null}
          {!sharedView && showingForgotten && forgottenTime !== undefined ? <>
            <div className={`${styles.tableHeading} ${styles.forgottenHeading}`} aria-hidden="true">
              <span>内容</span><span>忘记时间</span><span>状态</span>
            </div>
            <ol className={styles.list} aria-label="删除记录">
              {visibleForgotten.map((time, index) => <li key={`${time}-${pageStart + index}`}>
                <button type="button" className={`${styles.memoryRow} ${styles.forgottenRow}`}
                  aria-pressed={selectedForgottenIndex === pageStart + index} onClick={() => setForgottenIndex(pageStart + index)}>
                  <span className={styles.rowContent}>
                    <span className={styles.forgottenBadge}><MemoryIcon name="minus" /></span>已忘记的信息
                  </span>
                  <time className={styles.date} dateTime={new Date(time).toISOString()}>{timeFormat.format(time)}</time>
                  <span>正文已清理</span>
                </button>
              </li>)}
            </ol>
          </> : null}
          {!sharedView && !showingForgotten && !loading && overview && shown.length === 0 ? <div className={styles.empty}>
            <span className={styles.emptyIcon}><MemoryIcon name={memories.length === 0 ? 'note' : 'search'} /></span>
            {memories.length === 0 ? <>
              <h2>还没有记忆</h2>
              <p>正式聊天后，重要信息会逐渐出现在这里。</p>
            </> : <>
              <h2>没有找到相关记忆</h2>
              <p>试试换个关键词，或调整筛选条件。</p>
              <button type="button" className={styles.button}
                onClick={() => { setQuery(''); setCategory('all'); setFilter('all'); setListPage(0) }}>
                清除筛选
              </button>
            </>}
          </div> : null}
          {!sharedView && detail ? <>
            <div className={styles.tableHeading} aria-hidden="true"><span>内容</span><span>类别</span><span>使用范围</span><span>状态</span></div>
            <ol className={styles.list} aria-label="记忆列表">
              {visibleMemories.map((memory) => <li key={memory.id}>
                <button type="button" className={styles.memoryRow} data-state={memory.status} aria-pressed={detail.id === memory.id}
                  onClick={() => setDetailId(memory.id)}>
                  <span className={styles.rowContent}><MemoryIcon name={kindIcons[memory.kind]} /><span>{memory.content}</span></span>
                  <span>{kinds[memory.kind]}</span>
                  <span>{memory.scope === 'global' ? '用户明确共享' : privateScope}</span>
                  <span className={styles.state} data-state={memory.status}>{statuses[memory.status]}</span>
                </button>
              </li>)}
            </ol>
          </> : null}
        </div>
        {sharedView ? <footer className={styles.listFooter}>
          <p><MemoryIcon name="info" />共享资料供角色使用。聊天记录和私有记忆仍各自独立。</p>
        </footer> : hasDetail ? <footer className={styles.listFooter}>
          <p><MemoryIcon name="info" />{showingForgotten ? '已忘记记录只保留操作时间。' : '自动记忆只用于正式聊天，试聊不会写入这里。'}</p>
          <div className={styles.pagination} aria-label="记忆列表分页">
            <button type="button" className={styles.button} aria-label="上一页" disabled={currentPage === 0}
              onClick={() => setListPage(currentPage - 1)}><MemoryIcon name="left" /></button>
            <span aria-live="polite">{currentPage + 1} / {lastPage + 1}</span>
            <button type="button" className={styles.button} aria-label="下一页" disabled={currentPage === lastPage}
              onClick={() => setListPage(currentPage + 1)}><MemoryIcon name="right" /></button>
          </div>
        </footer> : null}
      </div>
      {!sharedView && detail ? <MemoryDetail key={detail.id} memory={detail} memories={memories}
        privateScope={privateScope} busy={busy} onSelect={select} onOpenSource={onOpenSource} /> : null}
      {!sharedView && showingForgotten && forgottenTime !== undefined ?
        <aside className={styles.detail} aria-labelledby="forgotten-detail-title">
          <h2 id="forgotten-detail-title">删除记录</h2>
          <div className={styles.forgottenSummary}>
            <div className={styles.forgottenStatus}>
              <span className={styles.forgottenBadge}><MemoryIcon name="minus" /></span>
              <div><strong>正文已清理</strong><p>这里只保留不含内容的删除标记和操作时间。</p></div>
            </div>
            <dl><dt>删除时间</dt><dd><time dateTime={new Date(forgottenTime).toISOString()}>{timeFormat.format(forgottenTime)}</time></dd></dl>
          </div>
        </aside> : null}
    </div>
    {createOpen ? <ConfirmationDialog title={createScope === 'global' ? '明确共享这条资料？' : '新增资料'}
      className={styles.memoryDialog} closeButton={{ disabled: busy }}
      onCancel={() => { if (!busy) setCreateOpen(false) }} actions={<>
      <button type="button" className={styles.button} disabled={busy} onClick={() => setCreateOpen(false)}>关闭</button>
      <button type="button" className={styles.primary} disabled={busy || !draft.trim() || !createScope}
        onClick={() => void saveMaterial()}>{error && createRequestId ? '重试' : createScope === 'global' ? '确认共享' : '保存资料'}</button>
    </>}>
      <label className={styles.edit}>资料内容
        <textarea rows={4} maxLength={400} value={draft} disabled={createRequestId !== null}
          onChange={(event) => setDraft(event.target.value)} />
      </label>
      <fieldset className={styles.choices} disabled={createRequestId !== null}>
        <legend>共享范围</legend>
        <label><input type="radio" name="memory-scope" checked={createScope === 'character'}
          onChange={() => setCreateScope('character')} />
          <span><strong>{privateScope}</strong><small>只在当前角色的正式聊天中使用这条资料。</small></span>
        </label>
        <label><input type="radio" name="memory-scope" checked={createScope === 'global'}
          onChange={() => setCreateScope('global')} />
          <span><strong>用户明确共享</strong><small>角色可以使用这条资料，聊天记录和其他私有记忆仍各自独立。</small></span>
        </label>
      </fieldset>
      {busy ? <p role="status">正在保存资料…</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </ConfirmationDialog> : null}
    {forgetFeedback ? <ConfirmationDialog title={forgetFeedback.phase === 'done' ? '已完成' : forgetFeedback.title}
      className={styles.memoryDialog} closeButton={{ disabled: busy }} onCancel={closeForgetFeedback} actions={<>
      {forgetFeedback.phase === 'working' ? <button type="button" className={styles.button} disabled>处理中…</button>
        : forgetFeedback.phase === 'done' ? <button type="button" className={styles.primary} disabled={busy}
          onClick={closeForgetFeedback}>完成</button>
        : <>
          <button type="button" className={styles.button} disabled={busy} onClick={closeForgetFeedback}>关闭</button>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void save(deletion ?? undefined)}>重试</button>
        </>}
    </>}>
      <div className={styles.feedback} data-phase={forgetFeedback.phase}
        role={forgetFeedback.phase === 'failed' ? 'alert' : 'status'}>
        <span className={styles.feedbackIcon} aria-hidden="true">
          {forgetFeedback.phase === 'working' ? null : <MemoryIcon name={forgetFeedback.phase === 'done' ? 'check' : 'warning'} />}
        </span>
        <strong>{forgetFeedback.phase === 'done' ? forgetFeedback.title : forgetFeedback.message}</strong>
        {forgetFeedback.phase === 'done' ? <p>{forgetFeedback.message}</p> : null}
        {forgetFeedback.phase === 'working' ? <p>清理完成后会显示结果。</p> : null}
        {forgetFeedback.phase === 'failed' ? <p>重试会继续原操作，已保存的部分不会重复写入。</p> : null}
      </div>
    </ConfirmationDialog> : selection ? <ConfirmationDialog title={selection.action === 'correct' ? conflictChoice ? '这条记忆已有更新'
      : sharedView ? '编辑共享资料' : '纠正这条记忆'
      : sharedView ? '删除这条共享资料？' : deletionReview ? '忘记并删除相关原文？' : '忘记这条记忆？'}
      className={deletionReview ? `${styles.memoryDialog} ${styles.wideDialog}` : styles.memoryDialog}
      closeButton={{ disabled: dialogBusy }}
      onCancel={() => { if (!dialogBusy) { setSelection(null); setDeletionReview(null) } }} actions={<>
        <button type="button" className={styles.button} disabled={dialogBusy}
          onClick={() => { setSelection(null); setDeletionReview(null) }}>取消</button>
        {selection.action === 'correct' ? <button type="button" className={styles.primary}
          disabled={busy || (conflictChoice !== 'keep' && (!draft.trim() || draft.trim() === selection.memory.content))}
          onClick={() => { if (conflictChoice === 'keep') setSelection(null); else void save() }}>
          {conflictChoice ? '确认选择' : '保存纠正'}
        </button>
          : sharedView ? <button type="button" className={styles.danger} disabled={busy} onClick={() => void save()}>删除共享资料</button>
          : deletion ? <button type="button" className={styles.danger} disabled={busy}
            onClick={() => void save(deletion)}>确认忘记并删除</button>
          : deletionReview ? <button type="button" className={styles.button} disabled={dialogBusy}
            onClick={() => void reviewDeletion()}>重新查看删除范围</button>
          : <button type="button" className={styles.danger} disabled={busy} onClick={() => void save()}>确认忘记</button>}
      </>}>
      {selection.action === 'correct' ? <>
        <div className={styles.comparison} data-conflict={!!conflictChoice}>
          <div><strong>当前内容</strong><p className={styles.target}>{selection.memory.content}</p></div>
          {conflictChoice ? <div><strong>本次填写</strong><p className={styles.target}>{draft.trim()}</p></div>
            : <label className={styles.edit}>改为
              <textarea rows={4} maxLength={400} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
            </label>}
        </div>
        {conflictChoice ? <fieldset className={styles.choices} disabled={busy}>
          <legend>请选择要保留的内容</legend>
          <label><input type="radio" name="memory-conflict" checked={conflictChoice === 'keep'}
            onChange={() => setConflictChoice('keep')} />
            <span><strong>保留当前内容</strong><small>继续使用现有记录。</small></span></label>
          <label><input type="radio" name="memory-conflict" checked={conflictChoice === 'replace'}
            disabled={draft.trim() === selection.memory.content} onChange={() => setConflictChoice('replace')} />
            <span><strong>改用本次填写</strong><small>用草稿替换当前记录。</small></span></label>
        </fieldset> : null}
        <div className={styles.scopeLine}><MemoryIcon name={selection.memory.scope === 'global' ? 'share' : 'lock'} />
          {selection.memory.scope === 'global' ? '用户明确共享' : privateScope}
        </div>
        {!conflictChoice ? <p className={styles.editHint}><MemoryIcon name="info" />保存后会保留旧记录，并让新内容生效。</p> : null}
      </> : <>
        {deletionReview ? <strong className={styles.fieldLabel}>本次待忘记信息</strong> : null}
        {sharedView ? <span className={styles.kind}>用户明确共享</span> : null}
        <p className={styles.target}>{selection.memory.content}</p>
        {!sharedView ? <div className={styles.forgetOptions}>
          {!deletionReview ? <p className={styles.defaultChoice}><span aria-hidden="true" />忘记此信息（聊天原文仍保留）</p> : null}
          <label className={styles.deleteChoice}>
            <input type="checkbox" checked={!!deletionReview} disabled={dialogBusy} onChange={(event) => {
              if (event.target.checked) void reviewDeletion()
              else { setDeletionReview(null); setError(null) }
            }} />
            <span><strong>同时删除原文</strong>{deletionReview ? <small>将忘记此信息，并删除下面列出的整条来源消息。</small> : null}</span>
          </label>
        </div> : null}
        {deletionReview === 'loading' ? <p role="status">正在读取将删除的原话…</p> : null}
        {deletion ? <div className={styles.deletionPreview}>
          <h3>即将删除的来源消息（{deletion.sources.length} 条）</h3>
          {deletion.sources.length === 0 ? <p>没有关联原话，这次只会忘记资料。</p> : <ol aria-label="即将删除的来源消息">
            {deletion.sources.map((source) => <li key={source.id}>
              <MemoryIcon name={source.role === 'user' ? 'person' : 'message'} />
              <div><time dateTime={new Date(source.createdAt).toISOString()}>{timeFormat.format(source.createdAt)}</time>
                <p><strong>{sourceRoles[source.role] ?? '消息'} · </strong>{source.content}</p></div>
            </li>)}
          </ol>}
        </div> : null}
        <div className={styles.warning} data-deleting={!!deletionReview}>
          <MemoryIcon name="info" />
          <ol>
            <li>同一信息的旧值也会忘记。整条相关原话将停止用于回复和整理，依赖记忆也可能失效。</li>
            {sharedView ? <li>相关原文仍保留，依赖共享资料的后续回复会更新。</li> : null}
            <li>角色设定里的相同内容需另行修改。</li>
            <li>你导出的旧备份仍可能包含这些信息。</li>
          </ol>
        </div>
      </>}
      {busy ? <p role="status">正在保存并清理本地上下文…</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </ConfirmationDialog> : null}
  </section>
}
