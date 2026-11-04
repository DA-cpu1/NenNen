/** 固定短文和长文检查批次书签，确认分段仍引用同一条原话。 */
import { describe, expect, it } from 'vitest'
import type { ContextMessage } from '../src/agent/turn-context'
import { planMemoryBatch } from '../src/jobs/memory-batch'

/** 构造已过来源过滤的消息。 */
function message(seq: number, content: string, role: ContextMessage['role'] = 'user'): ContextMessage {
  return { id: `msg-${seq}`, role, seq, content, replyToId: null, createdAt: 1_740_000_000_000 }
}

describe('固定整理批次', () => {
  it('批次最多 12000 码点，跨边界从同一用户消息续读', () => {
    const messages = [message(1, 'a'.repeat(7_999)), message(2, '虚构内容', 'assistant'), message(3, '中'.repeat(7_000))]
    const first = planMemoryBatch(messages, { seq: 0, offset: 0 })!
    expect(first.end).toEqual({ seq: 3, offset: 4_001 })
    expect(first.sources.map(({ id }) => id)).toEqual(['msg-1', 'msg-3'])
    const next = planMemoryBatch(messages, first.end)!
    expect(next.start).toEqual(first.end)
    expect(next.end).toEqual({ seq: 3, offset: 0 })
    expect(next.sources[0]).toMatchObject({ id: 'msg-3', content: '中'.repeat(2_999) })
    expect(planMemoryBatch(messages, next.end)).toBeNull()
  })

  it('字节上限考虑 JSON 转义和多字节码点，emoji 不会从中间截断', () => {
    const messages = [message(1, '中😀\n文')]
    const emptySourceBytes = Buffer.byteLength(JSON.stringify([{ id: 'msg-1', seq: 1, content: '', createdAt: 1_740_000_000_000 }]))
    const first = planMemoryBatch(messages, { seq: 0, offset: 0 }, emptySourceBytes + 8)!
    expect(first.sources[0].content).toBe('中😀')
    expect(first.end.offset).toBe(2)
    expect(planMemoryBatch(messages, first.end, emptySourceBytes + 8)?.sources[0].content).toBe('\n文')
  })
})
