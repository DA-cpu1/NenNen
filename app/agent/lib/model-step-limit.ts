/**
 * 在供应商请求发出前挡住第 4 次生成，避免等后台收到事件再取消时已经花钱。
 * 使用 eve 的公开 defineState 保存本轮计数；不保存人设、正文或密钥。
 */
import type { LanguageModelMiddleware } from 'ai'
import { defineState } from 'eve/context'
import { z } from 'zod'

/** 与 04 §2 的每轮生成上限一致；后台事件消费仍独立保留同一道兜底检查。 */
export const MAX_MODEL_GENERATIONS_PER_TURN = 3

// 这里只是执行额度，随 eve 会话丢弃也不影响聊天记录；用户数据仍只以 SQLite 为准。
// 使用同一状态槽可以覆盖同一步骤的供应商重试，不能只数步骤事件。
const modelBudget = defineState('companion.model-call-budget', () => ({ turnId: '', calls: 0 }))

/** 只检查本关卡需要的公开字段；其余事件资料不保存，也不放进错误消息。 */
const stepEventSchema = z.object({
  type: z.literal('step.started'),
  data: z.object({ stepIndex: z.number().int().nonnegative(), turnId: z.string().min(1) }),
})

/**
 * 把动态模型解析器收到的公开回合编号交给 SDK 调用前检查。
 * 检查放在 transformParams 而不是解析器里抛错：这样正常的步骤事件仍可送到
 * 后台，后台能把限额写成 E_TURN_LIMIT，同时模型请求始终不会越过这道关卡。
 * @param event eve 动态模型解析器收到的 step.started 事件
 * @returns 同时保护普通生成和流式生成的 middleware
 */
export function createModelStepLimitMiddleware(event: unknown): LanguageModelMiddleware {
  const checked = stepEventSchema.safeParse(event)
  if (!checked.success) throw new Error('E_INVALID_MODEL_STEP')
  const turnId = checked.data.data.turnId
  return {
    transformParams: async ({ params }) => {
      modelBudget.update((current) => {
        const calls = current.turnId === turnId ? current.calls : 0
        if (calls >= MAX_MODEL_GENERATIONS_PER_TURN) throw new Error('E_TURN_LIMIT')
        return { turnId, calls: calls + 1 }
      })
      return params
    },
  }
}
