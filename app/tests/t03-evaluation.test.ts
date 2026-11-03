/** 文件职责：用固定资料检查评测程序的预算、场景隔离和工具替身；这些检查不会调用模型。 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildMessages, constrainRequest, costCny, EvaluationBudget, loadSample, parseCases, rememberFixture } from '../scripts/t03/support'

describe('T03 评测执行前的固定关卡', () => {
  it('只取十二组和三十六句，移除给执行者的括号说明', async () => {
    const source = await readFile('../docs/sdd/T03-试聊案例.md', 'utf8')
    const cases = parseCases(source)
    expect(cases).toHaveLength(12)
    expect(cases.flatMap(item => item.turns)).toHaveLength(36)
    expect(cases.find(item => item.id === 'P10')?.turns[1]).toBe('我回来就说一句：刚才只是想安静一下。')
  })
  it('读取当前候选样稿；当前请求不泄露追问和评分重点', async () => {
    const sample = await loadSample(process.cwd())
    expect(sample.examples).toHaveLength(13)
    const prompt = buildMessages(sample, [], '晚上好，今天想随便聊聊。')
    const text = JSON.stringify(prompt)
    expect(text).not.toContain('路上看到一只猫趴在自行车座上')
    expect(text).not.toContain('至少 10 组')
    expect(prompt.at(-1)?.role).toBe('user')
  })
  it('先裁示例再裁完整旧轮，当前工具调用和结果保持', () => {
    const body = { messages: [
      { role: 'system', content: '共同规则' }, { role: 'system', content: '人设' },
      { role: 'system', content: '以下仅为表达示例' + '样'.repeat(4000) },
      { role: 'user', content: '旧'.repeat(4000) }, { role: 'assistant', content: '旧回复' },
      { role: 'user', content: '当前' }, { role: 'assistant', tool_calls: [{ id: 'call-1' }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":false}' },
    ] }
    const result = constrainRequest(body)
    expect(result.removedGroups).toBe(2)
    expect(result.body.messages).toHaveLength(5)
    expect(result.body.messages.at(-1)?.tool_call_id).toBe('call-1')
    expect(body.messages).toHaveLength(8)
  })
  it('核心输入放不下时直接拒绝', () => {
    expect(() => constrainRequest({ messages: [{ role: 'system', content: '规'.repeat(5000) },
      { role: 'user', content: '当前' }] })).toThrow('E_CONTEXT_BUDGET_EXCEEDED')
  })
  it('48 次最坏费用为 0.5952 元，第49次在发出前拒绝', () => {
    const budget = new EvaluationBudget()
    for (let index = 0; index < 48; index += 1) budget.reserve(12000, 0)
    expect(budget.totalCny()).toBeCloseTo(0.5952)
    expect(() => budget.reserve(100, 0)).toThrow('E_REQUEST_LIMIT')
  })
  it('小范围复试单独限制九次和0.12元；不能扩大原始上限', () => {
    const budget = new EvaluationBudget(9, 0.12)
    for (let index = 0; index < 9; index += 1) budget.reserve(12000, 0)
    expect(budget.totalCny()).toBeCloseTo(0.1116)
    expect(() => budget.reserve(100, 0)).toThrow('E_REQUEST_LIMIT')
    expect(() => new EvaluationBudget(9, 0.01).reserve(12000, 0)).toThrow('E_EVALUATION_BUDGET')
    expect(() => new EvaluationBudget(49, 0.60)).toThrow('E_INVALID_EVALUATION_LIMIT')
    expect(() => new EvaluationBudget(9, 0.61)).toThrow('E_INVALID_EVALUATION_LIMIT')
  })
  it('获准不限费用和输出时仍限制九次；未知费用不能显示为零', () => {
    const budget = new EvaluationBudget(9, null, null)
    const first = budget.reserve(12000, 0)
    expect(first.reservedCny).toBeNull()
    expect(budget.totalCny()).toBeNull()
    budget.settle(first, 2000, 1500)
    expect(budget.totalCny()).toBe(costCny(2000, 1500))
    for (let index = 1; index < 9; index += 1) budget.reserve(12000, 0)
    expect(() => budget.reserve(100, 0)).toThrow('E_REQUEST_LIMIT')
    expect(() => new EvaluationBudget(9, 0.12, null)).toThrow('E_INVALID_EVALUATION_LIMIT')
  })
  it('未知用量保留预占，精确用量才降低估算；实际超出预算后不再发请求', () => {
    const budget = new EvaluationBudget(), request = budget.reserve(12000, 0)
    budget.settle(request)
    expect(request.estimated).toBe(true)
    expect(request.chargedCny).toBe(costCny(12000, 1000))
    budget.settle(request, 2000, 500)
    expect(request.estimated).toBe(false)
    expect(request.chargedCny).toBe(costCny(2000, 500))
    budget.settle(request, 1_000_000, 1000)
    expect(() => budget.reserve(100, 0)).toThrow('E_EVALUATION_BUDGET')
  })
  it('工具只在真实请求、来源和内容都对应时成功，失败不改成成功', () => {
    const input = { content: '用户希望称呼为阿达', kind: 'preference', sourceMessageId: 'P11-u1' }
    expect(rememberFixture(input, 'P11-u1', '以后叫我阿达。', false).ok).toBe(true)
    expect(rememberFixture(input, 'P11-u2', '你准备怎么叫我？', false).ok).toBe(false)
    expect(rememberFixture(input, 'P11-u1', '以后叫我阿达。', true).code).toBe('STORAGE_UNAVAILABLE')
  })
})
