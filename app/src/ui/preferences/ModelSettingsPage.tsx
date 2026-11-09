/**
 * 软件设置中的模型与连接页：版式按 2026-11-09 的设置页设计稿。
 * 连接资料和回复参数（温度、Top P、思考开关与档位）都从这里编辑，
 * 保存成功后更新表单基线；失败保留草稿，离开页面前由应用壳统一拦截。
 *
 * 有些限制来自服务商本身，界面必须跟着约束，不能只靠提示词：
 * - DeepSeek 思考模式下温度不生效，所以温度框会锁成「由模型决定」；
 * - 智谱 GLM-5.3 系列不能关闭思考，开关会锁成开启。
 */
import { useEffect, useRef, useState } from 'react'
import type { CharacterOverview } from '../../shared/data-types'
import {
  DEEPSEEK_MODEL_CONNECTION, DEFAULT_MODEL_CONNECTION, isDeepSeekService, isSameModelService,
  isThinkingForced, modelConnectionSchema, reasoningEnabledFor,
  type ModelConnection, type ModelSettingsOverview, type ReasoningEffort,
} from '../../shared/model-settings'
import ConfirmationDialog from '../settings/ConfirmationDialog'
import { modelSettingsMessage } from './model-settings-messages'
import CredentialDialog from './CredentialDialog'
import styles from './ModelSettingsPage.module.css'

/** 公共状态来自应用壳，离开动作也由应用壳统一处理。 */
export interface ModelSettingsPageProps {
  overview: ModelSettingsOverview | null
  loadError: string | null
  reload: () => Promise<void>
  character: CharacterOverview | null
  leaving: boolean
  onLeave: () => void
  onStay: () => void
  /** 首次使用嵌入同一份表单，不复制一套保存逻辑。 */
  compact?: boolean
  onContinue?: () => void
  onOpenOnboarding?: () => void
}

/** 思考档位的中文名，底部摘要和下拉框共用，避免两处写法不一致。 */
const EFFORT_LABELS: Record<ReasoningEffort, string> = { low: '低', high: '高', max: '最高' }

/**
 * 快速配置只放已经核对过参数的预设。
 * DeepSeek 预设除了 API 密钥之外全部填好；GLM-5.3 强制思考，预设直接打开思考。
 */
const DEEPSEEK_PRESET: ModelConnection = {
  ...DEEPSEEK_MODEL_CONNECTION,
  displayName: 'DeepSeek Flash',
  temperature: null,
  topP: null,
  reasoning: { enabled: false, effort: null },
}

const GLM_PRESET: ModelConnection = {
  ...DEFAULT_MODEL_CONNECTION,
  displayName: 'GLM-5.3-Flash',
  temperature: null,
  topP: null,
  reasoning: { enabled: true, effort: null },
}

const PRESETS: Array<{ label: string; connection: ModelConnection }> = [
  { label: 'DeepSeek Flash', connection: DEEPSEEK_PRESET },
  { label: 'GLM-5.3-Flash', connection: GLM_PRESET },
]

/**
 * 显示名称的兜底值：旧配置没有保存名称时，按预设推导一个能看懂的名字。
 * @param connection 当前配置
 * @returns 预设名称；都对不上时按自定义服务显示
 */
function displayNameOf(connection: Pick<ModelConnection, 'provider' | 'model'>): string {
  if (connection.provider === 'deepseek' && connection.model === DEEPSEEK_MODEL_CONNECTION.model) return 'DeepSeek Flash'
  if (connection.provider === 'zhipu' && connection.model === DEFAULT_MODEL_CONNECTION.model) return 'GLM-5.3-Flash'
  return '自定义兼容服务'
}

/**
 * 三个字段都相同才算选中该预设；只改温度或容量时仍算同一套预设。
 * @param draft 正在编辑的配置
 * @param preset 预设配置
 * @returns 是否高亮这个预设按钮
 */
function samePreset(draft: Pick<ModelConnection, 'provider' | 'model' | 'baseUrl'>, preset: ModelConnection): boolean {
  return draft.provider === preset.provider && draft.model === preset.model && draft.baseUrl === preset.baseUrl
}

/**
 * 资料读到后才创建草稿，避免空表单覆盖已保存配置。
 * @param props 公开配置、角色图片、读取及草稿保护操作
 * @returns 模型设置页面或明确的读取状态
 */
export default function ModelSettingsPage(props: ModelSettingsPageProps) {
  useEffect(() => { if (!props.overview && props.leaving) props.onLeave() }, [props.overview, props.leaving, props.onLeave])
  if (!props.overview) return <div className={styles.empty}><h1>模型与连接</h1>
    <p>{props.loadError ? modelSettingsMessage(props.loadError) : '正在读取模型配置…'}</p>
    {props.loadError ? <button type="button" onClick={() => void props.reload()}>重新读取</button> : null}</div>
  return <ModelConnectionForm {...props} overview={props.overview} />
}

/**
 * 表单里的数字统一暂存为文字，允许用户先删掉旧值，再输入新的。
 * 空字符串表示「交给服务商默认值」，保存时转成 null。
 */
type ConnectionDraft = {
  provider: ModelConnection['provider']
  model: string
  baseUrl: string
  displayName: string
  temperature: string
  topP: string
  reasoningEnabled: boolean
  reasoningEffort: '' | ReasoningEffort
  contextWindowTokens: string
  outputReserveTokens: string
}

/** 把已保存的公开配置转换成可逐字编辑的表单。 */
function toDraft(connection: ModelConnection): ConnectionDraft {
  return {
    provider: connection.provider,
    model: connection.model,
    baseUrl: connection.baseUrl,
    displayName: connection.displayName ?? displayNameOf(connection),
    temperature: connection.temperature == null ? '' : String(connection.temperature),
    topP: connection.topP == null ? '' : String(connection.topP),
    reasoningEnabled: reasoningEnabledFor(connection),
    reasoningEffort: connection.reasoning?.effort ?? '',
    contextWindowTokens: String(connection.contextWindowTokens),
    outputReserveTokens: String(connection.outputReserveTokens),
  }
}

/** 把表单还原成要保存的配置；空温度、空 Top P 和「跟随模型」都存成 null。 */
function toConnection(draft: ConnectionDraft): ModelConnection {
  return {
    provider: draft.provider,
    model: draft.model,
    baseUrl: draft.baseUrl,
    displayName: draft.displayName.trim(),
    temperature: draft.temperature.trim() === '' ? null : Number(draft.temperature),
    topP: draft.topP.trim() === '' ? null : Number(draft.topP),
    reasoning: {
      enabled: draft.reasoningEnabled,
      effort: draft.reasoningEffort === '' ? null : draft.reasoningEffort,
    },
    contextWindowTokens: Number(draft.contextWindowTokens),
    outputReserveTokens: Number(draft.outputReserveTokens),
  }
}

/** 底部摘要用：把草稿的思考状态写成一句人话。 */
function draftReasoningText(draft: Pick<ConnectionDraft, 'reasoningEnabled' | 'reasoningEffort'>): string {
  if (!draft.reasoningEnabled) return '思考关闭'
  return draft.reasoningEffort ? `思考开启 · ${EFFORT_LABELS[draft.reasoningEffort]}` : '思考开启'
}

/** 仅在配置已读取后挂载，页面切换与保存请求分别保护草稿和重复点击。 */
function ModelConnectionForm(props: ModelSettingsPageProps & { overview: ModelSettingsOverview }) {
  const [draft, setDraft] = useState(() => toDraft(props.overview.settings?.connection ?? DEFAULT_MODEL_CONNECTION))
  const [saved, setSaved] = useState(draft)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'save' | 'delete' | 'test' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [testError, setTestError] = useState('')
  const operation = useRef(false)
  const requestId = useRef<string | null>(null)
  const testRunning = useRef(false)
  const testRequestId = useRef<string | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || apiKey !== ''
  const hasCredential = !!props.overview.settings?.credentialRef
  const needsNewKey = hasCredential && !isSameModelService(draft, saved)
  const blocked = props.loadError !== null
  const deepSeek = isDeepSeekService(draft)
  const thinkingForced = isThinkingForced(draft)
  // 智谱 GLM-5.3 传 disabled 会直接报错，只能锁成开启；DeepSeek 可以正常切换。
  const thinkingLocked = thinkingForced
  // DeepSeek 思考模式下温度不生效，界面锁成「由模型决定」，避免用户白填。
  const temperatureLocked = deepSeek && draft.reasoningEnabled

  useEffect(() => {
    if (!props.leaving) return
    if (busy) { setError('正在处理，请稍候再离开。'); props.onStay() }
    else if (!dirty) props.onLeave()
  }, [props.leaving, busy, dirty, props.onLeave, props.onStay])

  /** 改了内容就换保存编号，只有同一份内容的重试才沿用原编号。 */
  function edit(next: ConnectionDraft): void {
    setDraft(next); requestId.current = null; setError(''); setNotice('')
  }

  /**
   * 套用一套预设：整份连接资料和回复参数一起换，并清掉刚输入的新密钥。
   * 换供应商后旧密钥不能沿用，清空可避免把上一家的密钥发给下一家。
   */
  function applyPreset(connection: ModelConnection): void {
    setApiKey(''); setShowKey(false); edit(toDraft(connection))
  }

  /** 自定义服务没有预设值，把地址、模型和参数留空让用户自己填。 */
  function applyCustomPreset(): void {
    setApiKey(''); setShowKey(false)
    edit({
      provider: 'openai-compatible', model: '', baseUrl: '',
      displayName: '自定义兼容服务', temperature: '', topP: '',
      reasoningEnabled: false, reasoningEffort: '',
      contextWindowTokens: '', outputReserveTokens: '',
    })
  }

  /** 取消只清除本页草稿和新输入密钥，已保存的凭据不受影响。 */
  function discard(): void {
    setDraft(saved); setApiKey(''); requestId.current = null; setError(''); setNotice(''); setTestError(''); setNotice('已取消修改。')
  }

  /**
   * 校验、保存并等待主进程确认；成功后清除窗口中的新密钥。
   * @param replacement 更换弹窗的本次输入；省略时使用表单里的新密钥
   * @returns 是否已确认保存，供保存并离开和关闭弹窗使用
   */
  async function save(replacement?: string): Promise<boolean> {
    if (operation.current || blocked || busy !== null || !window.appApi) return false
    const connection = modelConnectionSchema.safeParse(toConnection(draft))
    if (!connection.success) {
      setError('请填写有效的显示名称、模型名称、服务地址和容量；温度 0–2、Top P 0–1，回复预留必须小于模型总容量。')
      return false
    }
    operation.current = true; setBusy('save'); setError(''); setNotice('')
    requestId.current ??= crypto.randomUUID()
    try {
      const newKey = replacement ?? apiKey
      const result = await window.appApi.saveModelSettings({ requestId: requestId.current, connection: connection.data,
        ...(newKey.trim() ? { apiKey: newKey.trim() } : {}) })
      if (!result.ok || !result.data) { setError(modelSettingsMessage(result.code)); await props.reload(); return false }
      const next = toDraft(result.data.settings!.connection)
      setDraft(next); setSaved(next); setApiKey(''); requestId.current = null
      setNotice(result.data.ready ? '配置已保存，后续请求使用当前配置。' : '配置已保存，请测试连接后开始聊天。')
      await props.reload()
      return true
    } catch { setError('保存尚未确认，请重试；填写内容仍保留。'); return false }
    finally { operation.current = false; setBusy(null) }
  }

  /** 只有主进程确认运行已停止且凭据已清理，才显示删除完成。 */
  async function remove(): Promise<void> {
    if (operation.current || !window.appApi) return
    operation.current = true; setBusy('delete'); setError(''); setNotice('')
    try {
      const result = await window.appApi.deleteModelCredential()
      if (!result.ok) { setError(modelSettingsMessage(result.code)); return }
      setApiKey(''); setDeleteOpen(false); setNotice('凭据已删除。本地聊天、记忆和人设仍保留。')
    } catch { setError('删除尚未完成，请重试。') }
    finally { operation.current = false; setBusy(null); await props.reload() }
  }

  /**
   * 测试的是已保存的配置，所以草稿没保存时按钮禁用。
   * 同一次传输失败沿用编号，后台会读已有回执，不重复请求供应商。
   */
  async function test(): Promise<void> {
    if (testRunning.current || dirty || blocked || busy !== null || !hasCredential || !window.appApi) return
    testRunning.current = true; setBusy('test'); setTestError(''); setError(''); setNotice('')
    testRequestId.current ??= crypto.randomUUID()
    try {
      const result = await window.appApi.testModelConnection(testRequestId.current)
      if (!result.ok) {
        setTestError(modelSettingsMessage(result.code))
        if (result.code !== 'BACKEND_UNREACHABLE') testRequestId.current = null
      } else testRequestId.current = null
      await props.reload()
    } catch { setTestError('测试回执尚未收到，重试会先读取本次结果。') }
    finally { testRunning.current = false; setBusy(null); setCancelling(false) }
  }

  /** 取消需要后台实际结束测试，不能刚点按钮就显示测试已完成。 */
  async function cancelTest(): Promise<void> {
    setCancelling(true)
    try {
      const result = await window.appApi?.cancelModelConnectionTest()
      if (!result?.ok) { setTestError('取消尚未确认，请重试取消。'); setCancelling(false) }
    } catch { setTestError('取消尚未确认，请重试取消。'); setCancelling(false) }
  }

  const storageText = props.overview.credentialStorage === 'encrypted' ? '已在本机加密保存'
    : props.overview.credentialStorage === 'memory' ? '仅保存在本次内存中，退出后需重新填写'
      : props.overview.credentialStorage === 'unavailable' ? '已保存凭据暂不可读取，请重新填写' : '尚未配置 API 凭据'

  // 连接状态取自已保存配置的测试结果，不把草稿状态混进「当前是否可用」。
  const testStatus = props.overview.settings?.testStatus
  const testStatusText = busy === 'test' ? '正在测试连接…'
    : props.overview.ready ? '连接正常 · 支持工具调用'
      : testStatus === 'unsupported' ? '可以连接，但不支持工具调用；记忆操作无法完成'
        : testStatus === 'failed' ? '连接失败，请检查密钥、模型和服务地址'
          : !hasCredential ? '尚未配置模型'
            : testStatus === 'passed' ? '模型尚未就绪，请重新保存配置' : '配置已保存，请测试连接'

  // Top P 的提示跟着服务商和思考状态走，避免把 DeepSeek 的规则套到智谱身上。
  const topPHint = !deepSeek ? '取值范围 0–1。'
    : !draft.reasoningEnabled ? (draft.model === 'deepseek-flash' ? '非思考模式固定为 1.0，填写不生效。' : '非思考模式可填 0–1。')
      : draft.model === 'deepseek-flash' ? '思考模式下可填 0.95–1.00。' : '思考模式下由模型决定，填写不生效。'

  // 容量减去回复预留，才是人设、记忆和聊天能用的输入空间。
  // 两个框都填了有效数字时才显示，避免用户刚删空一个就闪出负数。
  const totalTokens = Number(draft.contextWindowTokens)
  const reserveTokens = Number(draft.outputReserveTokens)
  const inputSpace = Number.isFinite(totalTokens) && Number.isFinite(reserveTokens) && totalTokens > reserveTokens
    ? totalTokens - reserveTokens : null

  return <div className={props.compact ? `${styles.layout} ${styles.compact}` : styles.layout}>
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className={styles.content}>
        <header className={styles.heading}>
          <div><h1>模型与连接</h1><p>选择模型，调整它的回复方式。</p></div>
          <div className={styles.headingSide}>
            <span className={styles.currentPill}>
              {hasCredential ? <>当前使用 <strong>{saved.displayName || displayNameOf(saved)}</strong> · {draftReasoningText(saved)}</> : '尚未配置模型'}
            </span>
            {!dirty && props.onOpenOnboarding ? <button type="button" onClick={props.onOpenOnboarding}>首次使用引导</button> : null}
          </div>
        </header>

        <div className={styles.presetBar} role="group" aria-label="快速配置">
          <span className={styles.presetLabel}>快速配置</span>
          {PRESETS.map((preset) => {
            const active = samePreset(draft, preset.connection)
            return <button key={preset.label} type="button" disabled={busy !== null || blocked}
              className={active ? styles.presetActive : styles.preset} aria-pressed={active}
              onClick={() => applyPreset(preset.connection)}>{preset.label}</button>
          })}
          <button type="button" disabled={busy !== null || blocked}
            className={draft.provider === 'openai-compatible' ? styles.presetActive : styles.preset}
            aria-pressed={draft.provider === 'openai-compatible'} onClick={applyCustomPreset}>自定义兼容服务</button>
        </div>

        <fieldset disabled={busy !== null || blocked} className={styles.fields}>
          <section className={styles.card}>
            <div className={styles.cardHead}><h2>连接配置</h2>
              <span className={styles.cardHint}>{dirty ? '正在编辑草稿' : '已保存配置'}</span></div>
            <div className={styles.grid2}>
              <label className={styles.field}><span className={styles.fieldLabel}>显示名称</span>
                <input value={draft.displayName} maxLength={60} autoComplete="off" placeholder="给这套配置起个名字"
                  onChange={(event) => edit({ ...draft, displayName: event.target.value })} /></label>
              <label className={styles.field}><span className={styles.fieldLabel}>服务商类型</span>
                <select value={draft.provider} onChange={(event) => {
                  const provider = event.target.value
                  if (provider === 'deepseek') applyPreset(DEEPSEEK_PRESET)
                  else if (provider === 'zhipu') applyPreset(GLM_PRESET)
                  else applyCustomPreset()
                }}>
                  <option value="zhipu">智谱 · OpenAI 兼容接口</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="openai-compatible">自定义兼容服务</option>
                </select></label>
              <label className={styles.field}><span className={styles.fieldLabel}>模型 ID</span>
                <input value={draft.model} autoComplete="off" placeholder="填写服务商的模型名称"
                  onChange={(event) => edit({ ...draft, model: event.target.value, contextWindowTokens: '', outputReserveTokens: '' })} /></label>
              <label className={styles.field}><span className={styles.fieldLabel}>API 地址</span>
                <input value={draft.baseUrl} type="url" autoComplete="off" placeholder="https://api.example.com/v1"
                  onChange={(event) => edit({ ...draft, baseUrl: event.target.value })} /></label>
            </div>
            <div className={styles.keyBlock}>
              <label className={styles.fieldLabel} htmlFor="model-api-key">API 密钥</label>
              <div className={styles.keyRow}>
                <input id="model-api-key" type={showKey ? 'text' : 'password'} value={apiKey} autoComplete="off" spellCheck={false}
                  placeholder={hasCredential && !needsNewKey ? '••••••••••••' : '请输入当前服务的 API 密钥'} onChange={(event) => {
                    setApiKey(event.target.value); requestId.current = null; setError(''); setNotice('')
                  }} />
                <button type="button" disabled={!hasCredential || dirty || busy !== null} onClick={() => {
                  requestId.current = null; setError(''); setNotice(''); setReplaceOpen(true)
                }}>更换</button>
              </div>
              <div className={styles.storageRow}>
                <span className={styles.storage}>{needsNewKey ? '填写新服务的 API 密钥后再保存。' : storageText}</span>
                <span className={styles.inlineActions}>
                  <button type="button" className={styles.linkButton} disabled={busy !== null}
                    onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏密钥' : '显示密钥'}</button>
                  {hasCredential ? <button type="button" className={styles.linkButton} disabled={busy !== null}
                    onClick={() => setDeleteOpen(true)}>删除凭据</button> : null}
                </span>
              </div>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}><h2>回复参数</h2>
              <span className={styles.cardHint}>应用于正式聊天和角色试聊</span></div>
            <div className={styles.grid2}>
              <label className={styles.field}><span className={styles.fieldLabel}>温度 <em>Temperature</em></span>
                <input type="number" min={0} max={2} step={0.1} value={temperatureLocked ? '' : draft.temperature}
                  placeholder={temperatureLocked ? '由模型决定' : '默认'} disabled={temperatureLocked}
                  onChange={(event) => edit({ ...draft, temperature: event.target.value })} />
                <span className={styles.fieldHint}>{temperatureLocked ? '思考开启时由模型决定温度。' : '留空表示使用服务商默认值。'}</span></label>
              <label className={styles.field}><span className={styles.fieldLabel}>候选范围 <em>Top P</em></span>
                <input type="number" min={0} max={1} step={0.01} value={draft.topP} placeholder="默认"
                  onChange={(event) => edit({ ...draft, topP: event.target.value })} />
                <span className={styles.fieldHint}>{topPHint}</span></label>
            </div>
            <div className={styles.thinkingBox}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>思考模式</span>
                <button type="button" role="switch" aria-checked={draft.reasoningEnabled}
                  className={draft.reasoningEnabled ? `${styles.toggle} ${styles.toggleOn}` : styles.toggle}
                  disabled={thinkingLocked || busy !== null || blocked}
                  onClick={() => edit({ ...draft, reasoningEnabled: !draft.reasoningEnabled })}>
                  <span className={styles.toggleTrack} aria-hidden="true"><span className={styles.toggleThumb} /></span>
                  <span>{draft.reasoningEnabled ? '已开启' : '已关闭'}</span>
                </button>
                <span className={styles.fieldHint}>
                  {thinkingForced ? '该模型强制开启思考，无法关闭。'
                    : deepSeek ? '开启后可能增加等待和用量；连接测试会临时关闭思考以检查工具调用。'
                      : '自定义服务只发送推理档位，是否生效取决于服务商。'}
                </span>
              </div>
              <label className={styles.field}><span className={styles.fieldLabel}>思考等级</span>
                <select value={draft.reasoningEffort} disabled={!draft.reasoningEnabled}
                  onChange={(event) => edit({ ...draft, reasoningEffort: event.target.value as '' | ReasoningEffort })}>
                  <option value="">跟随模型</option>
                  <option value="low">低</option>
                  <option value="high">高</option>
                  <option value="max">最高</option>
                </select>
                <span className={styles.fieldHint}>开启思考后可手动选择低、高、最高。</span></label>
            </div>
            <div className={styles.infoRow}><span className={styles.infoLabel}>识图</span><span>本地聊天仅接收文字</span></div>
            <details className={styles.capacity} open={!draft.contextWindowTokens || !draft.outputReserveTokens}>
              <summary>容量与生成上限</summary>
              <p>按服务商说明填写，单位为 token。回复预留用于给回答留出空间；开启思考后建议适当调大。</p>
              <div className={styles.grid2}>
                <label className={styles.field}><span className={styles.fieldLabel}>模型总容量</span>
                  <input type="number" min="1" step="1" value={draft.contextWindowTokens}
                    onChange={(event) => edit({ ...draft, contextWindowTokens: event.target.value })} /></label>
                <label className={styles.field}><span className={styles.fieldLabel}>回复预留</span>
                  <input type="number" min="1" step="1" value={draft.outputReserveTokens}
                    onChange={(event) => edit({ ...draft, outputReserveTokens: event.target.value })} /></label>
              </div>
              {inputSpace !== null ? <p className={inputSpace < 4_096 ? styles.warningHint : styles.fieldHint}>
                当前可用于人设、记忆和聊天的输入约 {inputSpace.toLocaleString('zh-CN')} token。
                {inputSpace < 4_096 ? ' 剩余空间过小，很可能放不下人设和历史。' : ''}
              </p> : null}
            </details>
          </section>
        </fieldset>

        {error || props.loadError || props.overview.code ? <p className={styles.error} role="alert">{error || modelSettingsMessage(props.loadError ?? props.overview.code)}</p> : null}
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerStatus}>
          <span className={dirty ? styles.statusLine : `${styles.statusLine} ${styles.statusLineSaved}`}>
            <span className={dirty ? styles.dot : `${styles.dot} ${styles.dotSaved}`} aria-hidden="true" />
            {dirty ? '未保存' : '已保存'} · {draftReasoningText(draft)}
          </span>
          <span className={testError ? styles.statusError : styles.statusText} role="status">{testError || testStatusText}</span>
        </div>
        <div className={styles.footerActions}>
          {busy === 'test'
            ? <button type="button" disabled={cancelling} onClick={() => void cancelTest()}>{cancelling ? '正在取消…' : '取消测试'}</button>
            : <button type="button" disabled={!hasCredential || dirty || blocked || busy !== null} onClick={() => void test()}
              title={dirty ? '请先保存本次配置，再测试连接。' : undefined}>测试连接</button>}
          <button type="button" disabled={!dirty || busy !== null} onClick={discard}>取消修改</button>
          {props.onContinue ? <button type="button" className={styles.primary} disabled={!props.overview.ready || dirty || busy !== null}
            onClick={props.onContinue}>下一步：试聊预览</button> : null}
          <button type="submit" className={styles.primary} disabled={busy !== null || blocked}>{busy === 'save' ? '正在保存…' : '保存配置'}</button>
        </div>
      </footer>
    </form>

    {replaceOpen ? <CredentialDialog busy={busy !== null} error={error} onChange={() => { requestId.current = null; setError('') }}
      onSave={save} onClose={() => setReplaceOpen(false)} /> : null}
    {deleteOpen ? <ConfirmationDialog title="删除 API 凭据？" onCancel={() => { if (!busy) setDeleteOpen(false) }}
      actions={<><button disabled={busy !== null} onClick={() => setDeleteOpen(false)}>取消</button>
        <button className={styles.danger} disabled={busy !== null} onClick={() => void remove()}>{busy === 'delete' ? '正在删除…' : '删除凭据'}</button></>}>
      <p>删除后无法请求模型；已有本地聊天记录仍可查看。</p><p>不会删除聊天、记忆和人设。</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}</ConfirmationDialog> : null}
    {props.leaving && dirty && !busy ? <ConfirmationDialog title="模型配置尚未保存" onCancel={props.onStay}
      actions={<><button onClick={props.onStay}>继续编辑</button><button onClick={() => { discard(); props.onLeave() }}>放弃修改</button>
        <button className={styles.primary} onClick={() => void save().then((ok) => { if (ok) props.onLeave(); else props.onStay() })}>保存并离开</button></>}>
      <p>离开前保存配置，或放弃本次填写。</p></ConfirmationDialog> : null}
  </div>
}
