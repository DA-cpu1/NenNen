/** 用安装版 AI SDK 的固定模型替身验证候选格式、单次调用和真实或估算用量。 */
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { extractCandidates, prepareMemoryExtraction } from '../src/jobs/extract-candidates'

const source = { id: 'source-1', seq: 1, content: '我喜欢水彩。', createdAt: 1_740_000_000_000 }
const prepared = prepareMemoryExtraction({ start: { seq: 1, offset: 0 }, end: { seq: 1, offset: 0 }, sources: [source] }, [])
const candidate = { action: 'add', kind: 'preference', memoryKey: 'painting_preference', content: '用户喜欢水彩。',
  sourceMessageIds: [source.id], expiresAt: null, replacesMemoryId: null }

/** 给 SDK 固定结束原因、原始文字和供应商可能缺省的用量。 */
function model(text: string, inputTokens?: number, outputTokens?: number) {
  return new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
    }, warnings: [],
  }) })
}

describe('整理候选输出', () => {
  it('只调用一次、按上限请求输出并返回纯 JSON 候选和准确用量', async () => {
    const mock = model(JSON.stringify({ candidates: [candidate] }), 111, 29)
    expect(await extractCandidates(mock, prepared, new AbortController().signal)).toEqual({
      ok: true, candidates: [candidate], usage: { inputTokens: 111, outputTokens: 29, estimated: false },
    })
    expect(mock.doGenerateCalls).toHaveLength(1)
    expect(mock.doGenerateCalls[0].maxOutputTokens).toBe(prepared.outputLimit)
    expect(JSON.stringify(mock.doGenerateCalls[0].prompt)).toContain(source.id)
  })

  it.each([
    '不是 JSON',
    JSON.stringify({ candidates: [candidate, { ...candidate, characterId: 'another' }] }),
    JSON.stringify({ candidates: Array(9).fill(candidate) }),
    JSON.stringify({ candidates: [{ ...candidate, action: 'replace' }] }),
  ])('无效格式整批拒绝并保留用量', async (text) => {
    expect(await extractCandidates(model(text, 120, 10), prepared, new AbortController().signal))
      .toEqual({ ok: false, code: 'E_INVALID_CANDIDATES', usage: { inputTokens: 120, outputTokens: 10, estimated: false } })
  })

  it('允许空候选，缺少用量时按保守预占计入', async () => {
    expect(await extractCandidates(model('{"candidates":[]}'), prepared, new AbortController().signal)).toEqual({
      ok: true, candidates: [], usage: { inputTokens: prepared.estimatedInputTokens, outputTokens: prepared.outputLimit, estimated: true },
    })
  })

  it('复用只携带旧记忆和本批来源编号', async () => {
    const reuse = { action: 'reuse', memoryId: 'old-1', sourceMessageIds: [source.id] }
    expect(await extractCandidates(model(JSON.stringify({ candidates: [reuse] })), prepared, new AbortController().signal))
      .toMatchObject({ ok: true, candidates: [reuse] })
    expect(await extractCandidates(model(JSON.stringify({ candidates: [{ ...reuse, content: '偷换旧正文' }] })),
      prepared, new AbortController().signal)).toMatchObject({ ok: false, code: 'E_INVALID_CANDIDATES' })
  })
})
