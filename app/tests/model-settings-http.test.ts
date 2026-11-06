/** 实际启动本机 HTTP 总机，检查认证、公开回包和运行切换错误码；不连接外网。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCompanionDatabase } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { createModelSettingsService } from '../src/service/model-settings'
import { startBackendServer, type BackendServer } from '../src/service/server'
import { DEFAULT_MODEL_CONNECTION } from '../src/shared/model-settings'

let database: ReturnType<typeof openCompanionDatabase>
let server: BackendServer
let busy = false
const replaceRuntime = vi.fn(async () => {})
const headers = { 'content-type': 'application/json', 'x-session-token': 'fixed-test-token' }
const input = { settings: { connection: DEFAULT_MODEL_CONNECTION,
  credentialRef: '550e8400-e29b-41d4-a716-446655440000', testStatus: 'untested' }, apiKey: 'fake-http-key' }

beforeEach(async () => {
  busy = false
  replaceRuntime.mockReset().mockResolvedValue(undefined)
  database = openCompanionDatabase(':memory:')
  runMigrations(database.sqlite)
  server = await startBackendServer('fixed-test-token', { modelSettings: createModelSettingsService({
    getDb: () => database.db, isChatBusy: () => busy, isRuntimeReady: () => false, replaceRuntime,
  }) })
})
afterEach(async () => { await server.stop(); database.close() })

/** 所有请求固定发往本次测试端口，不能误连到真实后台。 */
function url(path = '/model/settings') { return `http://127.0.0.1:${server.port}${path}` }

describe('模型设置本机通道', () => {
  it('未经认证不能读写，非法输入不触发换进程', async () => {
    expect((await fetch(url())).status).toBe(401)
    expect((await fetch(url(), { method: 'POST', headers, body: '{invalid' })).status).toBe(400)
    expect((await fetch(url(), { method: 'POST', headers, body: JSON.stringify({ ...input, extra: 'bad' }) })).status).toBe(400)
    expect(replaceRuntime).not.toHaveBeenCalled()
  })
  it('保存和重新读取的回包没有明文密钥，旧固定探针被关闭', async () => {
    const saved = await fetch(url(), { method: 'POST', headers, body: JSON.stringify(input) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ ok: true, ready: false, settings: input.settings })
    const text = await (await fetch(url(), { headers })).text()
    expect(text).not.toContain(input.apiKey)
    expect((await fetch(url('/model/ping'), { headers })).status).toBe(409)
    expect((await fetch(url('/model/key'), { method: 'POST', headers, body: JSON.stringify({ apiKey: 'fake' }) })).status).toBe(409)
  })
  it('忙碌和切换失败只返回固定码，不冒充成功', async () => {
    busy = true
    expect((await fetch(url(), { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(409)
    busy = false
    replaceRuntime.mockRejectedValueOnce(new Error(input.apiKey))
    const response = await fetch(url(), { method: 'POST', headers, body: JSON.stringify(input) })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, code: 'E_MODEL_UPDATE' })
  })
})
