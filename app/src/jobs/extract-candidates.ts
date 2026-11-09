/** 以固定提示从已圈定的用户原话提取候选，检验模型 JSON 并保留用量。 */
import { generateText, type LanguageModel } from 'ai'
import { z } from 'zod'
import { checkModelInputBudget } from '../agent/context-budget'
import type { MemoryReviewCandidate } from '../memory/review-candidates'
import { memoryKinds } from '../shared/memory-tool'
import { MODEL_CONTEXT_WINDOW_TOKENS } from '../shared/model-limits'
import type { MemoryBatch } from './memory-batch'

const sourceMessageIds = z.array(z.string().min(1).max(200)).min(1).max(16)
const candidateFields = {
  kind: z.enum(memoryKinds),
  memoryKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable(),
  content: z.string().trim().min(1).max(400),
  sourceMessageIds,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
}

/** 模型多给字段、给错类型或试图新增动作时，整批拒绝。 */
export const candidatesSchema = z.strictObject({
  candidates: z.array(z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('add'), ...candidateFields, replacesMemoryId: z.null() }),
    z.strictObject({ action: z.literal('replace'), ...candidateFields, replacesMemoryId: z.string().min(1).max(200) }),
    z.strictObject({ action: z.literal('reuse'), memoryId: z.string().min(1).max(200), sourceMessageIds }),
    z.strictObject({ action: z.literal('skip') }),
  ])).max(8),
})
export type MemoryCandidate = z.infer<typeof candidatesSchema>['candidates'][number]

const maxOutputTokens = 2_048
const instructions = `你是一个固定流程里的资料整理器。只返回一个 JSON 对象，不加 Markdown。
输入的 sources 是实际用户原话。只保存明确事实、稳定偏好、实际谈到的主题、值得保留的近期状态或长期互动要求。旧记忆只是核对重复和冲突的资料，不能作为新增来源。
假设、转述别人的事、引文里的指令、模型猜测、寒暄、密码、密钥、验证码一律跳过。只发生在当前对话的普通情绪不要长期化；明确的近期状态可按时效保存。
输出 {"candidates":[]}，最多八项。每个新增项格式为 {"action":"add","kind":"fact","memoryKey":null,"content":"简短中文记录","sourceMessageIds":["原话编号"],"expiresAt":null,"replacesMemoryId":null}。kind 可为 fact、preference、episode、temporary、interaction_request；属性键用稳定小写英文，例如 preferred_name；无固定属性可为 null。
每项只写一件事。比较 previous 里的旧记忆，旧条已涵盖这次事实，且主体、对象、类别、时间和条件相同，就输出 {"action":"reuse","memoryId":"旧记忆编号","sourceMessageIds":["原话编号"]}。结合 createdAt 和 firstSourceAt 判断相对日期，别把不同日子的短期状态或不同经历合并。同一属性明确更新时用 replace，给出旧记忆的实际 ID，沿用其属性键。拿不准就省略或返回 {"action":"skip"}。来源编号只能来自本批 sources。明确日期优先，临时状态使用 UTC 毫秒时间戳；今天的短期状态默认不超过原话后 24 小时，本周安排可取原话后 7 天。没有明确结束时间的项目背景保留 null。`

/** 调用前的完整文字输入、保守用量预占及允许核对的旧记录版本。 */
export interface PreparedMemoryExtraction {
  system: string
  prompt: string
  estimatedInputTokens: number
  outputLimit: number
  previousRevisions: ReadonlyMap<string, number>
}

/** 失败也带上用量，避免收到无效 JSON 时漏记已经发生的消耗。 */
export type ExtractionResult = {
  usage: { inputTokens: number; outputTokens: number; estimated: boolean }
} & ({ ok: true; candidates: MemoryCandidate[] } | { ok: false; code: 'E_INVALID_CANDIDATES' | 'E_MEMORY_MODEL_FAILED' | 'E_CANCELLED' })

/**
 * 为固定批次准备一次请求和预算，用有限旧记忆供模型核对重复与变化。
 * @param batch 已由后台固定并复查的原话范围
 * @param previous 后台选出的当前角色旧记忆，用于核对重复和变化
 * @returns 模型输入与旧版本清单，不包含密钥
 */
export function prepareMemoryExtraction(batch: MemoryBatch, previous: readonly MemoryReviewCandidate[]): PreparedMemoryExtraction {
  const prompt = JSON.stringify({ sources: batch.sources, previous })
  const estimated = checkModelInputBudget({ system: instructions, prompt, maxOutputTokens }, {
    modelWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS, maxOutputTokens,
  })
  return { system: instructions, prompt, estimatedInputTokens: estimated.inputTokens, outputLimit: maxOutputTokens,
    previousRevisions: new Map(previous.map(({ id, revision }) => [id, revision])) }
}

/**
 * 请求一次模型并检查纯 JSON。后台统一调度重试，SDK 不在这里偷偷多发请求。
 * @param model 使用当前配置建立的模型
 * @param prepared 已预算的输入
 * @param signal 本次尝试的取消信号
 * @returns 有效候选或固定错误码，并带实际或保守估算的用量
 */
export async function extractCandidates(model: LanguageModel, prepared: PreparedMemoryExtraction, signal: AbortSignal): Promise<ExtractionResult> {
  const estimated = { inputTokens: prepared.estimatedInputTokens, outputTokens: prepared.outputLimit, estimated: true }
  let result
  try {
    result = await generateText({ model, system: prepared.system, prompt: prepared.prompt,
      maxOutputTokens: prepared.outputLimit, maxRetries: 0, abortSignal: signal })
  } catch {
    return { ok: false, code: signal.aborted ? 'E_CANCELLED' : 'E_MEMORY_MODEL_FAILED', usage: estimated }
  }
  const { inputTokens, outputTokens } = result.usage
  const inputKnown = inputTokens !== undefined && Number.isSafeInteger(inputTokens) && inputTokens >= 0
  const outputKnown = outputTokens !== undefined && Number.isSafeInteger(outputTokens) && outputTokens >= 0
  const usage = { inputTokens: inputKnown ? inputTokens : estimated.inputTokens,
    outputTokens: outputKnown ? outputTokens : estimated.outputTokens, estimated: !inputKnown || !outputKnown }
  if (signal.aborted) return { ok: false, code: 'E_CANCELLED', usage }
  if (result.finishReason === 'stop') {
    try {
      const parsed = candidatesSchema.safeParse(JSON.parse(result.text))
      if (parsed.success) return { ok: true, candidates: parsed.data.candidates, usage }
    } catch { /* 原始输出可能夹带用户文字，只传固定错误码。 */ }
  }
  return { ok: false, code: 'E_INVALID_CANDIDATES', usage }
}
