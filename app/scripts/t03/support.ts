/**
 * 文件职责：为性格评测读取固定题目、约束单次输入与本轮费用，并提供隔离的保存工具替身。
 * 这里只处理虚构测试资料，不连接应用数据库；工具替身通过也不代表正式记忆功能完成。
 */
import { readFile } from 'node:fs/promises'

export const STAGE_CASE_IDS = ['P01', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P15', 'P18']
export const STYLE_CHECK_CASE_IDS = ['P01', 'P03', 'P06']
export const MODEL_ID = 'glm-5.3-flash'
export const MAX_REQUESTS = 48
export const MAX_OUTPUT_TOKENS = 1_000
export const INPUT_LIMIT = 12_000
export const BUDGET_CNY = 0.60

/** 专用评测资料的最小结构；观察项不进入模型消息。 */
export interface EvaluationCase { id: string; title: string; precondition: string; observation: string; turns: string[] }
export interface PromptMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Sample { commonRules: string; personaText: string; examples: { scene: string; user: string; character: string }[] }
export interface RequestRecord {
  id: number; inputEstimate: number; inputTokens?: number; outputTokens?: number
  estimated: boolean; reservedCny: number | null; chargedCny: number | null; removedGroups: number
}

/**
 * 从已审阅的 Markdown 直接取第一阶段题目，避免另抄一份时改掉固定追问。
 * @param source 固定案例全文
 * @returns 指定十二组，每组三句；格式不齐则拒绝运行
 */
export function parseCases(source: string): EvaluationCase[] {
  const cases = STAGE_CASE_IDS.map(id => {
    const block = source.match(new RegExp(`^## ${id} · ([^]*?)(?=^## |$(?![^]))`, 'm'))?.[1]
    if (!block) throw new Error('E_CASE_MISSING')
    const turns = ['开场', '追问1', '追问2'].map(label => {
      const text = block.match(new RegExp(`^- ${label}：(.*)$`, 'm'))?.[1]?.trim()
      if (!text) throw new Error('E_CASE_TURN_MISSING')
      // P10 的括号只告诉执行者「用户主动回来」，不是用户发给角色的话。
      return text.replace(/^（用户稍后主动发送）/, '')
    })
    return { id, title: block.split('\n')[0].trim(), turns,
      precondition: block.match(/^- 前置：(.*)$/m)?.[1] ?? '',
      observation: block.match(/^- 观察：(.*)$/m)?.[1] ?? '' }
  })
  return cases
}

/**
 * 只读随项目保存的当前候选样稿；与应用一样剥离文件头说明，并读取十三对原创示例。
 * @param appDirectory app 的绝对目录
 * @returns 核心人设、共同规则及示例；不读取密钥或真实用户资料
 */
export async function loadSample(appDirectory: string): Promise<Sample> {
  const sources = await Promise.all(['common-rules.md', 'rikka/persona.md', 'rikka/examples.md']
    .map(file => readFile(`${appDirectory}/characters/${file}`, 'utf8')))
  const examples: Sample['examples'] = []
  for (const block of sources[2].split(/^## /m).slice(1)) {
    const scene = block.split('\n')[0].replace(/^\d+\.\s*/, '').trim()
    for (const pair of block.matchAll(/用户：「([^]*?)」\s*六花：「([^]*?)」/g)) {
      examples.push({ scene, user: pair[1], character: pair[2] })
    }
  }
  if (examples.length !== 13) throw new Error('E_INVALID_CHARACTER_SAMPLE')
  const strip = (source: string): string => source.replace(/^<!--[^]*?-->\s*/, '').trim()
  return { commonRules: strip(sources[0]), personaText: strip(sources[1]), examples }
}

/**
 * 按应用相同的身份和组织方式准备输入；先保留历史，再按原次序放预算内的示例。
 * @param sample 本次待评价的候选样稿
 * @param history 本组已经发生的虚构对话，不含之后的追问
 * @param current 当前一句用户输入
 * @param context 只在工具组使用的当前来源编号和模拟记忆状态
 * @returns 给 SDK 的消息；这是独立内容评测，不经过 eve 或正式会话
 */
export function buildMessages(sample: Sample, history: PromptMessage[], current: string, context = ''): PromptMessage[] {
  const required: PromptMessage[] = [
    { role: 'system', content: sample.commonRules },
    { role: 'system', content: '本轮角色设定：\n' + JSON.stringify({ name: '六花', versionId: null,
      versionNo: 0, personaText: sample.personaText, initialRelationship: '恋人', userNickname: null }) },
  ]
  if (context) required.push({ role: 'system', content: context })
  const selected: Sample['examples'] = []
  const tail: PromptMessage[] = [...history, { role: 'user', content: current }]
  // 用完整请求关卡再次兜底；这里先筛示例，避免把预算全部交给无关样例。
  for (const example of sample.examples) {
    const candidate = [...required, { role: 'system', content: '以下仅为表达示例，不是实际共同经历：\n' + JSON.stringify([...selected, example]) }, ...tail]
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 256 > INPUT_LIMIT) break
    selected.push(example)
  }
  if (selected.length) required.push({ role: 'system', content: '以下仅为表达示例，不是实际共同经历：\n' + JSON.stringify(selected) })
  return [...required, ...tail]
}

/**
 * 关卡看 SDK 真正要发出的 JSON；超限时先移除示例，再移除最早整轮历史。
 * @param body 只有公开请求内容的对象，不包含 Authorization 密钥
 * @returns 裁剪后的请求、保守输入估算和移除组数；核心或当前工具结果超限则拒绝
 */
export function constrainRequest(body: { messages: Record<string, unknown>[]; [key: string]: unknown }): {
  body: typeof body; inputEstimate: number; removedGroups: number
} {
  const copy = structuredClone(body)
  let removedGroups = 0
  let inputEstimate = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 256
  while (inputEstimate > INPUT_LIMIT) {
    const example = copy.messages.findIndex(message => message.role === 'system' &&
      typeof message.content === 'string' && message.content.startsWith('以下仅为表达示例'))
    if (example >= 0) copy.messages.splice(example, 1)
    else {
      const userIndexes = copy.messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
      if (userIndexes.length < 2) throw new Error('E_CONTEXT_BUDGET_EXCEEDED')
      copy.messages.splice(userIndexes[0], userIndexes[1] - userIndexes[0])
    }
    removedGroups += 1
    inputEstimate = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 256
  }
  return { body: copy, inputEstimate, removedGroups }
}

/**
 * 先按满额输出预占本次费用，再允许发请求；未知用量始终按预占值记账，不能算免费。
 * @param inputTokens 输入 token 数或保守估算值
 * @param outputTokens 输出 token 数或预留上限
 * @returns 按 2026-11-03 官方公开单价计算的人民币估算，不读取账户账单
 */
export function costCny(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 0.8 + outputTokens * 2.8) / 1_000_000
}

/** 本轮独用的请求账本；落实获准请求数，有限额度时拦超额，不限金额时保留未知用量。 */
export class EvaluationBudget {
  readonly requests: RequestRecord[] = []
  private readonly maxRequests: number
  private readonly budgetCny: number | null
  private readonly maxOutputTokens: number | null
  /**
   * 小范围复试可以减少额度；用户明确要求费用不限时用 null，不能用一个很大的假数字代替。
   * @param maxRequests 本次最多实际请求数，默认完整第一阶段的 48 次
   * @param budgetCny 本次人民币上限，默认 0.60 元；null 仅用于本次明确获准不限金额的范围
   * @param maxOutputTokens 每次输出预留；null 表示不设置应用输出上限，费用未知时也保留 null
   */
  constructor(maxRequests = MAX_REQUESTS, budgetCny: number | null = BUDGET_CNY,
    maxOutputTokens: number | null = MAX_OUTPUT_TOKENS) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS ||
        (budgetCny !== null && (!Number.isFinite(budgetCny) || budgetCny <= 0 || budgetCny > BUDGET_CNY)) ||
        (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) ||
        (budgetCny !== null && maxOutputTokens === null)) throw new Error('E_INVALID_EVALUATION_LIMIT')
    // 单独声明和赋值，让 Node 24 能直接去掉类型后运行，不依赖额外编译工具。
    this.maxRequests = maxRequests
    this.budgetCny = budgetCny
    this.maxOutputTokens = maxOutputTokens
  }
  /** @returns 已发生或预占的费用；不限输出且用量未知时返回 null，不能把未知当免费。 */
  totalCny(): number | null {
    let total = 0
    for (const request of this.requests) {
      if (request.chargedCny === null) return null
      total += request.chargedCny
    }
    return total
  }
  /**
   * @param inputEstimate 本次实际 JSON 的保守输入估算
   * @param removedGroups 本次裁掉多少可选资料组
   * @returns 可持久化的请求登记；不带消息正文和密钥
   */
  reserve(inputEstimate: number, removedGroups: number): RequestRecord {
    if (!Number.isSafeInteger(inputEstimate) || inputEstimate <= 0 || inputEstimate > INPUT_LIMIT) throw new Error('E_CONTEXT_BUDGET_EXCEEDED')
    if (this.requests.length >= this.maxRequests) throw new Error('E_REQUEST_LIMIT')
    const reservedCny = this.maxOutputTokens === null ? null : costCny(inputEstimate, this.maxOutputTokens)
    const total = this.totalCny()
    if (this.budgetCny !== null && (total === null || reservedCny === null ||
        total + reservedCny > this.budgetCny)) throw new Error('E_EVALUATION_BUDGET')
    const request = { id: this.requests.length + 1, inputEstimate, estimated: true,
      reservedCny, chargedCny: reservedCny, removedGroups }
    this.requests.push(request)
    return request
  }
  /**
   * @param request 对应本次已预占的请求
   * @param inputTokens SDK 报告输入；缺失或为零不当成精确值
   * @param outputTokens SDK 报告输出；包含供应商计入的思考用量
   * @returns 无；用量不明时保留原预占值
   */
  settle(request: RequestRecord, inputTokens?: number, outputTokens?: number): void {
    if (inputTokens === undefined || inputTokens <= 0 || outputTokens === undefined || outputTokens < 0) return
    request.inputTokens = inputTokens
    request.outputTokens = outputTokens
    request.estimated = false
    request.chargedCny = costCny(inputTokens, outputTokens)
  }
}

/**
 * 保存称呼的测试替身：只维护本组假状态，绝不声称接通正式数据库。
 * @param input 模型实际交来的内容与来源
 * @param sourceId 当前虚构用户消息编号
 * @param sourceText 当前虚构用户原话
 * @param fail P18 固定失败；P11 成功只存在本组状态里
 * @returns 工具结果；无效来源或未要求长期记住时不返回成功
 */
export function rememberFixture(input: { content: string; kind: string; memoryKey?: string; sourceMessageId: string },
  sourceId: string, sourceText: string, fail: boolean): Record<string, unknown> {
  if (input.sourceMessageId !== sourceId || !sourceText.includes('阿达') ||
      !/以后|记住/.test(sourceText) || !input.content.includes('阿达') || input.kind !== 'preference' ||
      (input.memoryKey !== undefined && input.memoryKey !== 'preferred_name')) {
    return { ok: false, code: 'SOURCE_NOT_ALLOWED', retryable: false }
  }
  if (fail) return { ok: false, code: 'STORAGE_UNAVAILABLE', retryable: false, message: '本次未能保存，下次打开不能保证可用。' }
  return { ok: true, memoryId: 'fixture-preferred-name', revision: 1, status: 'saved' }
}
