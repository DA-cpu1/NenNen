/**
 * 后台服务最小行为检查（T01 / 03 §3）：
 * 随机端口、令牌认证、未认证拒绝。
 * 使用固定输入与固定令牌，符合 07 §3「自动检查不用概率性输入」的要求。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startBackendServer, type BackendServer } from '../src/service/server'

// 测试专用固定令牌，与生产生成的随机令牌无关
const TOKEN = 'test-fixed-token'

/** 全部用例共享的服务句柄，最后统一关闭 */
let server: BackendServer | undefined

beforeAll(async () => {
  server = await startBackendServer(TOKEN)
})

afterAll(async () => {
  await server?.stop()
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
