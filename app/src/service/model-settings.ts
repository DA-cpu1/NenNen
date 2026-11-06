/**
 * 后台统一管理公开配置和当前模型是否可用。
 * 先保存配置，再更换运行进程；更换失败就保持不可用，绝不拿旧密钥冒充新配置成功。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { readSetting, writeSetting } from '../data/settings'
import {
  applyModelSettingsSchema, MODEL_SETTINGS_KEY, storedModelSettingsSchema,
  type ApplyModelSettings, type ModelConnection, type StoredModelSettings,
} from '../shared/model-settings'

/** 具体怎样停止 eve 由入口处理，这里只负责配置顺序和可用性。 */
export interface ModelSettingsDependencies {
  getDb(): BetterSQLite3Database | undefined
  isChatBusy(): boolean
  isRuntimeReady(): boolean
  replaceRuntime(connection: ModelConnection, apiKey: string | null): Promise<void>
}

/**
 * 建立配置管理服务；密钥只在闭包内保留，概览永远不返回它。
 * @param deps 数据库、聊天忙闲状态和运行进程替换操作
 * @returns 公开概览、保存、可用性及当前公开配置读取能力
 */
export function createModelSettingsService(deps: ModelSettingsDependencies) {
  let changing = false
  let activeKey: string | null = null
  let activeConnection: ModelConnection | undefined

  /** 数据库不可用或设置损坏都明确报错，不能偷偷套用默认模型。 */
  function read(): StoredModelSettings | null {
    const db = deps.getDb()
    if (!db) throw new Error('E_DB_NOT_OPEN')
    try {
      const value = readSetting(db, MODEL_SETTINGS_KEY)
      return value === undefined ? null : storedModelSettingsSchema.parse(value)
    } catch { throw new Error('E_MODEL_SETTINGS_READ') }
  }

  /** 只有当前进程就绪且这份配置通过能力检查，才能受理智能聊天和整理。 */
  function isUsable(): boolean {
    return !changing && activeKey !== null && deps.isRuntimeReady() && read()?.testStatus === 'passed'
  }

  /** 不含密钥的概览可经主进程交给界面。 */
  function overview() {
    return { settings: read(), ready: isUsable() }
  }

  /**
   * 保存一整份配置并等待新运行进程接班；保存请求本身不会调用供应商。
   * @param input 主进程交来的公开配置、凭据引用及仅在内存传递的密钥
   * @returns 实际保存后的公开概览；失败抛固定码
   */
  async function apply(input: ApplyModelSettings) {
    const checked = applyModelSettingsSchema.safeParse(input)
    if (!checked.success) throw new Error('INVALID_INPUT')
    if (changing || deps.isChatBusy()) throw new Error('E_MODEL_BUSY')
    const previous = read()
    const same = previous?.credentialRef === checked.data.settings.credentialRef
      && JSON.stringify(previous?.connection) === JSON.stringify(checked.data.settings.connection)
    // passed 只能来自已保存的真实测试，不接受调用方随手填写的成功标签。
    const settings: StoredModelSettings = { ...checked.data.settings,
      testStatus: same && checked.data.apiKey ? previous!.testStatus : 'untested' }
    if (same && checked.data.apiKey === activeKey && deps.isRuntimeReady()) return overview()
    const db = deps.getDb()!
    try { writeSetting(db, MODEL_SETTINGS_KEY, settings) }
    catch { throw new Error('E_MODEL_SETTINGS_SAVE') }
    changing = true
    activeKey = null
    activeConnection = undefined
    try {
      await deps.replaceRuntime(settings.connection, checked.data.apiKey)
      activeKey = checked.data.apiKey
      activeConnection = settings.connection
    } catch { throw new Error('E_MODEL_UPDATE') }
    finally { changing = false }
    return overview()
  }

  return { read, apply, overview, isUsable,
    /** 回合记账和容量检查读取当前进程真正使用的公开配置。 */
    getConnection: () => activeConnection }
}

export type ModelSettingsService = ReturnType<typeof createModelSettingsService>
