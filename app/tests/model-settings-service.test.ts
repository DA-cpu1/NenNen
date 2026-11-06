/** 用内存 SQLite 与可控的运行替身检查配置切换，不运行真实模型或修改用户数据。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCompanionDatabase } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { readSetting, writeSetting } from '../src/data/settings'
import { createModelSettingsService } from '../src/service/model-settings'
import { DEFAULT_MODEL_CONNECTION, MODEL_SETTINGS_KEY, type ApplyModelSettings } from '../src/shared/model-settings'

let database: ReturnType<typeof openCompanionDatabase>
const input: ApplyModelSettings = { settings: { connection: DEFAULT_MODEL_CONNECTION,
  credentialRef: '550e8400-e29b-41d4-a716-446655440000', testStatus: 'untested' }, apiKey: 'fake-runtime-key' }

beforeEach(() => { database = openCompanionDatabase(':memory:'); runMigrations(database.sqlite) })
afterEach(() => database.close())

/** 每个案例创建独立状态；replaceRuntime 的调用次数代表实际换进程次数。 */
function setup() {
  let busy = false
  let ready = false
  const replaceRuntime = vi.fn(async (_connection: unknown, key: string | null) => { ready = key !== null })
  const service = createModelSettingsService({ getDb: () => database.db,
    isChatBusy: () => busy, isRuntimeReady: () => ready, replaceRuntime })
  return { service, replaceRuntime, setBusy: (value: boolean) => { busy = value } }
}

describe('后台模型设置生命周期', () => {
  it('未配置时本地读取正常；保存不会把明文写进 SQLite，未经测试不可用', async () => {
    const { service } = setup()
    expect(service.overview()).toEqual({ settings: null, ready: false })
    expect(await service.apply(input)).toMatchObject({ ready: false, settings: input.settings })
    expect(JSON.stringify(readSetting(database.db, MODEL_SETTINGS_KEY))).not.toContain(input.apiKey)
  })
  it('同一配置重试不重复替换进程，界面伪造的 passed 不生效', async () => {
    const { service, replaceRuntime } = setup()
    const forged: ApplyModelSettings = { ...input, settings: { ...input.settings, testStatus: 'passed' } }
    expect(await service.apply(forged)).toMatchObject({ ready: false, settings: { testStatus: 'untested' } })
    await service.apply(forged)
    expect(replaceRuntime).toHaveBeenCalledTimes(1)
  })
  it('同一已通过配置重启可恢复；更改模型就必须重新测试', async () => {
    writeSetting(database.db, MODEL_SETTINGS_KEY, { ...input.settings, testStatus: 'passed' })
    const { service } = setup()
    expect(await service.apply(input)).toMatchObject({ ready: true })
    expect(await service.apply({ ...input, settings: { ...input.settings,
      connection: { ...DEFAULT_MODEL_CONNECTION, model: 'another-model' } } })).toMatchObject({ ready: false })
  })
  it('活跃聊天先停止，拒绝更改时不写配置也不换进程', async () => {
    const { service, setBusy, replaceRuntime } = setup()
    setBusy(true)
    await expect(service.apply(input)).rejects.toThrow('E_MODEL_BUSY')
    expect(service.read()).toBeNull()
    expect(replaceRuntime).not.toHaveBeenCalled()
  })
  it('新进程失败不回退旧密钥，保留本次配置以供明确重配', async () => {
    const { service, replaceRuntime } = setup()
    await service.apply(input)
    replaceRuntime.mockRejectedValueOnce(new Error('private-error'))
    const next = { ...input, apiKey: 'another-fake-key', settings: { ...input.settings,
      credentialRef: '550e8400-e29b-41d4-a716-446655440001' } }
    await expect(service.apply(next)).rejects.toThrow(/^E_MODEL_UPDATE$/)
    expect(service.overview()).toMatchObject({ ready: false, settings: next.settings })
    expect(service.getConnection()).toBeUndefined()
  })
  it('删除凭据后清除运行连接；损坏设置不回退到默认配置', async () => {
    const { service, replaceRuntime } = setup()
    await service.apply(input)
    await service.apply({ settings: { ...input.settings, credentialRef: null }, apiKey: null })
    expect(service.overview()).toMatchObject({ ready: false, settings: { credentialRef: null } })
    expect(replaceRuntime).toHaveBeenLastCalledWith(DEFAULT_MODEL_CONNECTION, null)
    writeSetting(database.db, MODEL_SETTINGS_KEY, { apiKey: 'must-not-be-accepted' })
    expect(() => service.read()).toThrow('E_MODEL_SETTINGS_READ')
  })
})
