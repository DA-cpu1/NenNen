/**
 * 主进程把“保管凭据”和“后台保存公开配置”接成一次用户操作。
 * 明文只送本机认证通道；页面获得的概览不含密钥，失败也只返回固定错误码。
 */
import type { BackendHandle } from './backend'
import type { ModelCredentialStore } from './model-credentials'
import type { BridgeResult } from '../bridge/requests'
import { saveModelSettingsSchema, type ModelConnectionTest, type ModelSettingsOverview, type StoredModelSettings } from '../shared/model-settings'

interface BackendSnapshot { settings: StoredModelSettings | null; ready: boolean; onboardingCompleted: boolean }

/**
 * 建立软件设置的主进程操作；不在创建时读文件或发模型请求。
 * @param getBackend 当前后台句柄，后台未就绪时返回 undefined
 * @param credentials 主进程专属的凭据保管箱
 * @param notify 只通知窗口重新读取状态，不携带凭据
 * @returns 读取、保存、删除和启动恢复操作
 */
export function createDesktopModelSettings(
  getBackend: () => BackendHandle | undefined,
  credentials: ModelCredentialStore,
  notify: () => void,
) {
  let working = false
  let credentialError: string | undefined

  /** 网址只能是这里写死的本机设置端点，窗口不能指定任意后台地址。 */
  async function request<T = BackendSnapshot>(method: 'GET' | 'POST', body?: unknown,
    path: '/model/settings' | '/model/test' | '/model/test/cancel' | '/onboarding/complete' = '/model/settings'): Promise<BridgeResult<T>> {
    const backend = getBackend()
    if (!backend) return { ok: false, code: 'BACKEND_NOT_READY' }
    try {
      const response = await fetch(`http://127.0.0.1:${backend.port}${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-session-token': backend.token },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35_000),
      })
      const result = await response.json() as BackendSnapshot & ModelConnectionTest & { ok: boolean; code?: string; cancelled?: boolean }
      if (!response.ok || !result.ok) return { ok: false, code: result.code ?? 'E_MODEL_UPDATE' }
      const data = path === '/model/settings' || path === '/onboarding/complete'
        ? { settings: result.settings, ready: result.ready, onboardingCompleted: result.onboardingCompleted }
        : path === '/model/test' ? { status: result.status, usage: result.usage } : { cancelled: result.cancelled }
      return { ok: true, data: data as T }
    } catch { return { ok: false, code: 'BACKEND_UNREACHABLE' } }
  }

  /** 公开概览只描述凭据存放方式；缺少或损坏凭据不能被显示为可用。 */
  async function read(): Promise<BridgeResult<ModelSettingsOverview>> {
    const result = await request('GET')
    if (!result.ok || !result.data) return result as BridgeResult<ModelSettingsOverview>
    const reference = result.data.settings?.credentialRef
    try {
      const credentialStorage = reference ? await credentials.storage(reference) : 'missing'
      return { ok: true, data: { ...result.data, credentialStorage,
        ready: result.data.ready && credentialStorage !== 'missing' && !credentialError,
        ...(credentialError ? { code: credentialError, credentialStorage: 'unavailable' as const } : {}) } }
    } catch { return { ok: true, data: { ...result.data, ready: false, credentialStorage: 'unavailable', code: 'E_CREDENTIAL_READ' } } }
  }

  /** 串行办理保存和删除，避免两份配置分别拿走对方的凭据。 */
  async function change(action: () => Promise<BridgeResult<ModelSettingsOverview>>): Promise<BridgeResult<ModelSettingsOverview>> {
    if (working) return { ok: false, code: 'E_MODEL_BUSY' }
    working = true
    try { return await action() }
    catch (error) {
      const code = error instanceof Error && /^E_CREDENTIAL_[A-Z_]+$/.test(error.message) ? error.message : 'E_MODEL_UPDATE'
      return { ok: false, code }
    } finally { working = false; notify() }
  }

  /** 用户保存时先保管新凭据，随后才让后台保存它的编号并更换进程。 */
  async function save(body: unknown): Promise<BridgeResult<ModelSettingsOverview>> {
    const checked = saveModelSettingsSchema.safeParse(body)
    if (!checked.success) return { ok: false, code: 'INVALID_INPUT' }
    return change(async () => {
      const previous = await request('GET')
      if (!previous.ok || !previous.data) return previous as BridgeResult<ModelSettingsOverview>
      const input = checked.data
      const old = previous.data.settings
      if (!input.apiKey && old && (old.connection.baseUrl !== input.connection.baseUrl || old.connection.provider !== input.connection.provider)) {
        return { ok: false, code: 'E_CREDENTIAL_REQUIRED_FOR_ADDRESS' }
      }
      const reference = input.apiKey ? input.requestId : old?.credentialRef
      if (!reference) return { ok: false, code: 'E_CREDENTIAL_MISSING' }
      if (input.apiKey) await credentials.save(reference, input.apiKey)
      const key = input.apiKey ?? await credentials.read(reference)
      if (!key) return { ok: false, code: 'E_CREDENTIAL_MISSING' }
      const applied = await request('POST', { settings: { connection: input.connection,
        credentialRef: reference, testStatus: 'untested' }, apiKey: key })
      if (!applied.ok) return applied as BridgeResult<ModelSettingsOverview>
      credentialError = undefined
      // 只有 SQLite 确认引用新文件后才删旧文件；失败时仍可按原请求重试清理。
      await credentials.removeUnused(reference)
      return read()
    })
  }

  /** 先撤下运行连接，再删除所有未被配置引用的凭据；任何一步失败都不报告完成。 */
  async function remove(): Promise<BridgeResult<ModelSettingsOverview>> {
    return change(async () => {
      const current = await request('GET')
      if (!current.ok || !current.data) return current as BridgeResult<ModelSettingsOverview>
      if (current.data.settings) {
        const applied = await request('POST', { settings: { ...current.data.settings, credentialRef: null, testStatus: 'untested' }, apiKey: null })
        if (!applied.ok) return applied as BridgeResult<ModelSettingsOverview>
      }
      await credentials.removeUnused(null)
      credentialError = undefined
      return read()
    })
  }

  /** 已保存的配置恢复到本机进程；这里不调用供应商，也不读取旧明文文件。 */
  async function restore(): Promise<BridgeResult<ModelSettingsOverview>> {
    return change(async () => {
      const current = await request('GET')
      if (!current.ok || !current.data) return current as BridgeResult<ModelSettingsOverview>
      const settings = current.data.settings
      if (!settings?.credentialRef) return read()
      try {
        const key = await credentials.read(settings.credentialRef)
        if (!key) { credentialError = 'E_CREDENTIAL_MISSING'; return read() }
        const restored = await request('POST', { settings, apiKey: key })
        if (!restored.ok) return restored as BridgeResult<ModelSettingsOverview>
        credentialError = undefined
      } catch { credentialError = 'E_CREDENTIAL_DECRYPT' }
      return read()
    })
  }

  return { read, save, remove, restore,
    /** 用户明确结束或跳过引导后保存标记；下次启动不反复弹出。 */
    completeOnboarding: () => change(async () => {
      const result = await request('POST', undefined, '/onboarding/complete')
      return result.ok ? read() : result as BridgeResult<ModelSettingsOverview>
    }),
    /** 手动测试独立于保存；回执丢失后可沿用编号读取既有结果。 */
    test: (requestId: string) => request<ModelConnectionTest>('POST', { requestId }, '/model/test').finally(notify),
    /** 用户明确点击取消后，请后台结束正在等待的测试。 */
    cancelTest: () => request<{ cancelled: boolean }>('POST', undefined, '/model/test/cancel'),
  }
}

export type DesktopModelSettings = ReturnType<typeof createDesktopModelSettings>
