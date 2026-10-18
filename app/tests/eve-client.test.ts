/**
 * 检查 eve 的成功判定：收到 202 或会话回到 waiting 都不等于当前轮成功。
 * 用固定事件模拟失败和取消，不启动进程，也不调用真实模型。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pingEve } from '../src/agent/eve-client'
import type { EveHandle } from '../src/agent/eve-process'

const fake = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('eve/client', () => ({
  Client: class {
    sessions = { create: fake.create }
  },
}))
const handle: EveHandle = { port: 12345, token: 'fake-token', dataDir: 'unused', stop: async () => {} }

beforeEach(() => { fake.create.mockReset() })

describe('eve 最终结果判定', () => {
  it('会话等待下一句且本轮完成时，返回最终文字与用量', async () => {
    fake.create.mockResolvedValue({ response: { result: async () => ({
      status: 'waiting', message: '收到', events: [
        { type: 'session.waiting', data: { usage: { inputTokens: 8, outputTokens: 2 } } },
      ],
    }) } })
    expect(await pingEve(handle, new AbortController().signal)).toEqual({
      text: '收到', usage: { inputTokens: 8, outputTokens: 2 },
    })
  })

  it.each(['turn.failed', 'turn.cancelled'])('即使有半截文字，%s 也不能算成功', async (type) => {
    fake.create.mockResolvedValue({ response: { result: async () => ({
      status: 'waiting', message: '半截回复', events: [{ type, data: {} }],
    }) } })
    await expect(pingEve(handle, new AbortController().signal)).rejects.toThrow('E_EVE_TURN_FAILED')
  })

  it('框架抛错时，不转发原错误里可能包含的密钥', async () => {
    fake.create.mockRejectedValue(new Error('fake-secret-and-prompt'))
    await expect(pingEve(handle, new AbortController().signal)).rejects.toThrow(/^E_EVE_TURN_FAILED$/)
  })
})
