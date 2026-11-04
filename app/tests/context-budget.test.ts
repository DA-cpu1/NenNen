/**
 * 固定文字检查预算边界、必需内容保留和来源整组裁剪。
 * 不使用真实模型估分，不读正式库，不把保守估算冒充供应商实际用量。
 */
import { describe, expect, it } from 'vitest'
import { checkModelInputBudget, prepareBudgetedContext } from '../src/agent/context-budget'
import type { ContextMessage, TurnContext } from '../src/agent/turn-context'
import { MODEL_CONTEXT_WINDOW_TOKENS, MODEL_OUTPUT_RESERVE_TOKENS } from '../src/shared/model-limits'

const limits = { modelWindowTokens: 32_000, outputReserveTokens: 1_000 }

/** 每次返回独立的人设和消息，避免某项检查改动资料后影响下一项。 */
function context(): TurnContext {
  return {
    conversationId: 'normal', conversationMode: 'normal' as const, characterId: 'character',
    characterName: '测试角色', contextEpoch: 0,
    commonRules: '不编造共同经历。',
    persona: { versionId: 'version-2', versionNo: 2, personaText: '完整性格与说话方式。',
      initialRelationship: '恋人', userNickname: '阿达', dialogueExamples: [] },
    history: [], currentMessage: message('current', 100, 'user', '当前问题'),
  }
}

/** 构造上一步已确认可用的文字消息；来源编号用于检查裁剪是否留下孤立回复。 */
function message(
  id: string, seq: number, role: ContextMessage['role'], content: string, replyToId: string | null = null,
): ContextMessage {
  return { id, seq, role, content, replyToId, createdAt: 1740000005000 }
}

describe('输入预算与历史裁剪（T06⑨b）', () => {
  it('产品只给模型最大回复留空位，不把预留变成请求输出上限', () => {
    const result = checkModelInputBudget('a'.repeat(20_000), {
      modelWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS, outputReserveTokens: MODEL_OUTPUT_RESERVE_TOKENS,
    })
    expect(result.inputLimit).toBe(868_928)
    expect(result.maxOutputTokens).toBeUndefined()
  })

  it.each([-1, 1.5, NaN, Infinity])('拒绝不合法的独立回复预留 %s', (outputReserveTokens) => {
    expect(() => checkModelInputBudget('短句', { ...limits, outputReserveTokens })).toThrow('E_INVALID_MODEL_LIMITS')
  })

  it('输入可超过旧 12,000 额度，只在模型窗口扣除预留后的边界拒绝', () => {
    // ASCII 字母各一字节；JSON 字符串有两个引号，另外有 256 的协议预留。
    expect(checkModelInputBudget('a'.repeat(30_742), limits)).toEqual({
      inputTokens: 31_000, inputLimit: 31_000, outputReserveTokens: 1_000,
      maxOutputTokens: undefined, usageEstimated: true,
    })
    expect(() => checkModelInputBudget('a'.repeat(30_743), limits)).toThrow('E_CONTEXT_BUDGET_EXCEEDED')
  })

  it('较小模型窗口减去输出预留后才是有效输入上限', () => {
    expect(checkModelInputBudget('a'.repeat(742), { modelWindowTokens: 2_000, outputReserveTokens: 1_000 })).toMatchObject({
      inputTokens: 1_000, inputLimit: 1_000,
    })
    expect(() => checkModelInputBudget('a'.repeat(743), { modelWindowTokens: 2_000, outputReserveTokens: 1_000 }))
      .toThrow('E_CONTEXT_BUDGET_EXCEEDED')
    expect(checkModelInputBudget('a'.repeat(742), { modelWindowTokens: 1_500, maxOutputTokens: 500 }))
      .toMatchObject({ inputLimit: 1_000, maxOutputTokens: 500 })
  })

  it.each([0, -1, 2.5, NaN, Infinity])('拒绝未知或不合法的窗口 %s，不猜默认大窗口', (window) => {
    expect(() => checkModelInputBudget('短句', { modelWindowTokens: window })).toThrow('E_INVALID_MODEL_LIMITS')
  })

  it.each([0, -1, 1.5, NaN])('拒绝不合法输出预留 %s', (output) => {
    expect(() => checkModelInputBudget('短句', { ...limits, maxOutputTokens: output })).toThrow('E_INVALID_MODEL_LIMITS')
  })

  it('输出预留已经用尽窗口时拒绝，即使输入很短也不放行', () => {
    expect(() => checkModelInputBudget('', { modelWindowTokens: 1_000, outputReserveTokens: 1_000 }))
      .toThrow('E_CONTEXT_BUDGET_EXCEEDED')
  })

  it('计入中文、emoji、转义和工具资料，始终标成估算', () => {
    const ascii = checkModelInputBudget('aa', limits)
    const chinese = checkModelInputBudget('中中', limits)
    const emoji = checkModelInputBudget('😀😀', limits)
    expect(chinese.inputTokens).toBeGreaterThan(ascii.inputTokens)
    expect(emoji.inputTokens).toBeGreaterThan(chinese.inputTokens)
    expect(() => checkModelInputBudget({ prompt: '很短', tools: [{ description: 'a'.repeat(32_000) }] }, limits))
      .toThrow('E_CONTEXT_BUDGET_EXCEEDED')
  })

  it('规则、人设、示例、历史和当前消息按固定顺序放入；当前消息只一次', () => {
    const input = context()
    input.persona.dialogueExamples = [{ scene: '风格', user: '示例问', character: '示例答' }]
    input.history = [message('u1', 1, 'user', '过去的问句'), message('a1', 2, 'assistant', '过去的答句', 'u1')]
    const result = prepareBudgetedContext(input, limits)
    expect(result.prompt.map((item) => item.role)).toEqual(['system', 'system', 'system', 'user', 'assistant', 'user'])
    expect(result.prompt[1].content).toContain(input.persona.personaText)
    expect(result.prompt[1].content).toContain(input.persona.initialRelationship)
    expect(result.prompt[1].content).toContain(input.persona.userNickname)
    expect(result.prompt[1].content).toContain('version-2')
    expect(result.prompt[2].content).toContain('不是实际共同经历')
    expect(result.historyMessageIds).toEqual(['u1', 'a1'])
    expect(result.exampleCount).toBe(1)
    expect(result.optionalPromptGroups).toEqual([[2], [3, 4]])
    expect(result.prompt.filter((item) => item.content === '当前问题')).toHaveLength(1)
    expect(result.prompt.at(-1)).toEqual({ role: 'user', content: '当前问题' })
  })

  it('很长人设或必需资料放不下时明确失败，不静默截断', () => {
    const input = context()
    input.persona.personaText = '人设'.repeat(6_000)
    expect(() => prepareBudgetedContext(input, { modelWindowTokens: 12_000 })).toThrow('E_CONTEXT_BUDGET_EXCEEDED')
    expect(input.persona.personaText).toBe('人设'.repeat(6_000))
    input.persona.personaText = '短人设'
    input.currentMessage.content = '中'.repeat(8_000)
    expect(() => prepareBudgetedContext(input, { modelWindowTokens: 12_000 })).toThrow('E_CONTEXT_BUDGET_EXCEEDED')
    expect(input.currentMessage.content).toHaveLength(8_000)
  })

  it('准备上下文时也拒绝超 8,000 字符，不靠历史已保存就绕过本轮关卡', () => {
    const input = context()
    input.currentMessage.content = 'a'.repeat(8_001)
    expect(() => prepareBudgetedContext(input, limits)).toThrow('E_MESSAGE_TOO_LONG')
  })

  it('优先近期真实对话，再加示例；不改动快照或原始历史', () => {
    const input = context()
    input.persona.dialogueExamples = [{ scene: '长示例', user: 'a'.repeat(5_000), character: '示例答' }]
    input.history = [
      message('old-u', 1, 'user', 'a'.repeat(5_000)), message('old-a', 2, 'assistant', '旧回复', 'old-u'),
      message('new-u', 3, 'user', '最近问题'), message('new-a', 4, 'assistant', '最近回复', 'new-u'),
    ]
    const before = JSON.stringify(input)
    const result = prepareBudgetedContext(input, { modelWindowTokens: 2_500, outputReserveTokens: 1_000 })
    expect(result.historyMessageIds).toEqual(['new-u', 'new-a'])
    expect(result.exampleCount).toBe(0)
    expect(result.inputTokens).toBeLessThanOrEqual(1_500)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('相关记忆优先于历史和示例，实际请求补裁时最后移除', () => {
    const input = context()
    input.relatedMemories = [{ id: 'mem', content: '曾聊到水彩。', scope: 'character',
      origin: 'conversation_event', validFrom: 1, expiresAt: null, revision: 1 }]
    input.persona.dialogueExamples = [{ scene: '风格', user: '示例问', character: '示例答' }]
    input.history = [message('u1', 1, 'user', 'a'.repeat(900))]
    const complete = prepareBudgetedContext(input, limits)
    expect(complete.prompt[3].content).toContain('曾聊到水彩。')
    expect(complete.optionalPromptGroups).toEqual([[2], [4], [3]])
    const small = prepareBudgetedContext(input, { modelWindowTokens: 1_000 })
    expect(small.prompt[2].content).toContain('曾聊到水彩。')
    expect(small.historyMessageIds).toEqual([])
    expect(small.prompt.at(-1)?.content).toBe('当前问题')
  })

  it('原话、回复与有来源的主动消息整组裁剪，不留下孤立引用', () => {
    const input = context()
    input.history = [
      message('source', 1, 'user', 'a'.repeat(3_000)),
      message('reply', 2, 'assistant', '回复', 'source'),
      message('p1', 3, 'proactive', '主动消息', 'reply'),
      message('p2', 4, 'proactive', '后续主动消息', 'p1'),
    ]
    expect(prepareBudgetedContext(input, { modelWindowTokens: 2_500 }).historyMessageIds).toEqual([])
    const complete = prepareBudgetedContext(input, limits)
    expect(complete.historyMessageIds).toEqual(['source', 'reply', 'p1', 'p2'])
    expect(complete.prompt.find((item) => item.content.includes('【主动消息】'))?.role).toBe('assistant')
  })

  it('独立主动消息可以入选；不同组交错时最终仍按原顺序发送', () => {
    const input = context()
    input.history = [
      message('u1', 1, 'user', '问题一'), message('u2', 2, 'user', '问题二'),
      message('a1', 3, 'assistant', '回复一', 'u1'), message('p', 4, 'proactive', '独立主动消息'),
    ]
    expect(prepareBudgetedContext(input, limits).historyMessageIds).toEqual(['u1', 'u2', 'a1', 'p'])
  })

  it('新调用方传入来源缺失的回复时拒绝，不能让裁剪代码成为绕行入口', () => {
    const input = context()
    input.history = [message('orphan', 1, 'assistant', '孤立回复', 'missing')]
    expect(() => prepareBudgetedContext(input, limits)).toThrow('E_CONTEXT_SOURCE_UNAVAILABLE')
  })
})
