/** 将凭据保管、真实本机 HTTP 和内存 SQLite 接在一起，模拟保存与重新启动。 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModelCredentialStore, type CredentialEncryption } from '../src/desktop/model-credentials'
import { createDesktopModelSettings } from '../src/desktop/model-settings-controller'
import { openCompanionDatabase } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { createModelSettingsService } from '../src/service/model-settings'
import { startBackendServer, type BackendServer } from '../src/service/server'
import { DEFAULT_MODEL_CONNECTION } from '../src/shared/model-settings'

let directory: string
let database: ReturnType<typeof openCompanionDatabase>
let server: BackendServer
let ready: boolean
const replaceRuntime = vi.fn(async (_connection: unknown, key: string | null) => { ready = key !== null })
// 假加密只检查传递与文件生命周期；真实 safeStorage 另做原生窗口验收。
const encryption: CredentialEncryption = { isAvailable: async () => true,
  encrypt: async (value) => Buffer.from(value).reverse(), decrypt: async (value) => Buffer.from(value).reverse().toString() }
const body = { requestId: '550e8400-e29b-41d4-a716-446655440000', connection: DEFAULT_MODEL_CONNECTION, apiKey: 'fake-desktop-key' }

beforeEach(async () => {
  ready = false
  replaceRuntime.mockClear()
  directory = await mkdtemp(join(tmpdir(), 'companion-model-settings-'))
  database = openCompanionDatabase(':memory:')
  runMigrations(database.sqlite)
  server = await startBackendServer('fixed-token', { modelSettings: createModelSettingsService({
    getDb: () => database.db, isChatBusy: () => false, isRuntimeReady: () => ready, replaceRuntime,
  }) })
})
afterEach(async () => { await server.stop(); database.close(); await rm(directory, { recursive: true, force: true }) })

/** 每次新建主进程控制器，代表应用内存被清空但同一批配置文件仍在。 */
function controller(adapter = encryption) {
  return createDesktopModelSettings(() => ({ port: server.port, token: 'fixed-token', stop: async () => {} }),
    createModelCredentialStore(directory, adapter), () => {})
}

describe('桌面模型设置操作', () => {
  it('保存、重复保存和重新读取不返回密钥；重新启动可按引用恢复', async () => {
    const desktop = controller()
    expect(await desktop.save(body)).toMatchObject({ ok: true, data: { credentialStorage: 'encrypted' } })
    expect(await desktop.save(body)).toMatchObject({ ok: true })
    expect(replaceRuntime).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await desktop.read())).not.toContain(body.apiKey)
    expect(await controller().restore()).toMatchObject({ ok: true, data: { settings: { credentialRef: body.requestId } } })
  })
  it('新凭据成功后清理旧文件，删除可重复且运行连接确实撤下', async () => {
    const desktop = controller()
    await desktop.save(body)
    const next = { ...body, requestId: '550e8400-e29b-41d4-a716-446655440001', apiKey: 'another-fake-key' }
    expect(await desktop.save(next)).toMatchObject({ ok: true })
    expect(await readdir(join(directory, 'model-credentials'))).toEqual([`${next.requestId}.bin`])
    expect(await desktop.remove()).toMatchObject({ ok: true, data: { ready: false, credentialStorage: 'missing' } })
    expect(await desktop.remove()).toMatchObject({ ok: true })
    expect(await readdir(join(directory, 'model-credentials'))).toEqual([])
    expect(ready).toBe(false)
  })
  it('修改服务地址必须重新输入凭据，不能把旧凭据误发给新服务', async () => {
    const desktop = controller()
    await desktop.save(body)
    expect(await desktop.save({ requestId: body.requestId, connection: { ...DEFAULT_MODEL_CONNECTION,
      baseUrl: 'https://another.example.com/v1' } })).toEqual({ ok: false, code: 'E_CREDENTIAL_REQUIRED_FOR_ADDRESS' })
    expect(replaceRuntime).toHaveBeenCalledTimes(1)
  })
  it('内存凭据退出后明确缺失；解密失败明确不可用，不回退明文文件', async () => {
    const memory = controller({ ...encryption, isAvailable: async () => false })
    expect(await memory.save(body)).toMatchObject({ ok: true, data: { credentialStorage: 'memory' } })
    expect(await controller().restore()).toMatchObject({ ok: true, data: { ready: false, code: 'E_CREDENTIAL_MISSING' } })
    await controller().save(body)
    const broken = controller({ ...encryption, decrypt: async () => { throw new Error('private') } })
    expect(await broken.restore()).toMatchObject({ ok: true, data: { ready: false, code: 'E_CREDENTIAL_DECRYPT' } })
  })
})
