/**
 * 后台服务最小行为检查（T01 / 03 §3）：
 * 随机端口、令牌认证、未认证拒绝、模型自测端点。
 * 使用固定输入与固定令牌，模型一律用注入的假函数——自动检查不真调付费接口（07 §3）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startBackendServer, type BackendServer } from '../src/service/server'

// 测试专用固定令牌，与生产生成的随机令牌无关
const TOKEN = 'test-fixed-token'

/** 全部用例共享的服务句柄，最后统一关闭 */
let server: BackendServer | undefined
/** 各用例自己开的额外服务，一并登记统一关闭 */
const extraServers: BackendServer[] = []

beforeAll(async () => {
  server = await startBackendServer(TOKEN)
})

afterAll(async () => {
  await server?.stop()
  for (const s of extraServers) await s.stop()
})

describe('后台服务监听', () => {
  it('绑定 127.0.0.1 的随机端口', () => {
    expect(server).toBeDefined()
    expect(server!.port).toBeGreaterThan(0)
    expect(server!.port).toBeLessThanOrEqual(65535)
  })
})

describe('后台服务认证', () => {
  it('携带正确令牌访问 /health 返回 200 与 ok:true', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/health`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('未带令牌返回 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/health`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('令牌错误同样返回 401（不泄露令牌对错细节）', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/health`, {
      headers: { 'x-session-token': 'wrong-token' },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('认证通过但路径不存在返回 404', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/no-such-path`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('eve 自测端点 /agent/ping', () => {
  it('未认证时不会启动 Agent 调用', async () => {
    let calls = 0
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key',
      pingAgent: async () => {
        calls += 1
        return { text: '收到', usage: undefined }
      },
    })
    extraServers.push(fake)
    const response = await fetch(`http://127.0.0.1:${fake.port}/agent/ping`)
    expect(response.status).toBe(401)
    expect(calls).toBe(0)
  })

  it('缺密钥与未启动 eve 都明确拒绝，不假装成功', async () => {
    const headers = { 'x-session-token': TOKEN }
    const noKey = await fetch(`http://127.0.0.1:${server!.port}/agent/ping`, { headers })
    expect(noKey.status).toBe(503)
    expect(await noKey.json()).toEqual({ ok: false, code: 'NO_KEY' })
    const withoutAgent = await startBackendServer(TOKEN, { modelApiKey: 'fake-key' })
    extraServers.push(withoutAgent)
    const noAgent = await fetch(`http://127.0.0.1:${withoutAgent.port}/agent/ping`, { headers })
    expect(await noAgent.json()).toEqual({ ok: false, code: 'AGENT_UNAVAILABLE' })
  })

  it('完整调用成功才返回文字与用量', async () => {
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key',
      pingAgent: async (signal) => {
        expect(signal.aborted).toBe(false)
        return { text: '收到', usage: { inputTokens: 8, outputTokens: 2 } }
      },
    })
    extraServers.push(fake)
    const response = await fetch(`http://127.0.0.1:${fake.port}/agent/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true, text: '收到', usage: { inputTokens: 8, outputTokens: 2 },
    })
  })

  it('失败只返回错误码，不泄露异常里的机密或提示词', async () => {
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key',
      pingAgent: async () => { throw new Error('fake-key + 不应泄露的提示词') },
    })
    extraServers.push(fake)
    const response = await fetch(`http://127.0.0.1:${fake.port}/agent/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ ok: false, code: 'AGENT_ERROR' })
  })
})

describe('模型自测端点 /model/ping', () => {
  it('未配置密钥返回 503 NO_KEY', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/model/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'NO_KEY' })
  })

  it('注入假模型函数：返回 200 与固定回复，且密钥原样传给模型层', async () => {
    let receivedKey = ''
    let receivedPrompt = ''
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key-123',
      callModel: async (key, prompt) => {
        receivedKey = key
        receivedPrompt = prompt
        return { text: '收到', usage: { inputTokens: 5, outputTokens: 2 } }
      },
    })
    extraServers.push(fake)
    const res = await fetch(`http://127.0.0.1:${fake.port}/model/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      text: '收到',
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    // 验证密钥从服务层原样到达模型连接层（管道没丢没改）
    expect(receivedKey).toBe('fake-key-123')
    expect(receivedPrompt).toBe('请只回复两个字：收到')
  })

  it('模型函数抛错时返回 502 MODEL_ERROR 并带原因', async () => {
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key-123',
      callModel: async () => {
        throw new Error('模拟供应商断线')
      },
    })
    extraServers.push(fake)
    const res = await fetch(`http://127.0.0.1:${fake.port}/model/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { ok: boolean; code: string; message: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('MODEL_ERROR')
    expect(body.message).toContain('模拟供应商断线')
  })

  it('不带令牌打 /model/ping 同样 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/model/ping`)
    expect(res.status).toBe(401)
  })
})
