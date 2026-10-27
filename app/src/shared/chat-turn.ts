/**
 * 聊天回合在「界面 ↔ 后台」之间的请求与事件契约。
 * 请求体用 zod 在服务端把关；事件类型描述 SSE 流里每一帧的形状。
 * 这层只定义「线上长什么样」，不引用 Agent 层的实现（分层：shared 谁都可以
 * import，反过来 agent/service 引 shared，不能让 shared 反过来依赖它们）。
 */
import { z } from 'zod'

/** 发起一次聊天回合的请求体；requestId 由界面生成，重试沿用同一个编号。 */
export const chatTurnRequestSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  // 这里的长度上限只是传输防线（防止超大请求体）；真正的 8,000 码点关卡
  // 在数据层落库前执行，绕过界面也拦得住。
  content: z.string().min(1).max(20_000),
})

/** 服务端校验后的请求。 */
export type ChatTurnRequest = z.infer<typeof chatTurnRequestSchema>

/** SSE 流里的一帧。saved 是首帧：告诉界面用户消息已落库及其编号。 */
export type SseTurnEvent =
  | { type: 'saved'; userMessageId: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; replyId: string }
  | { type: 'cancelled' }
  | { type: 'failed'; code: string }

/** 取消当前回合的请求体：按会话取消，一个会话同时最多一个活动回合。 */
export const chatTurnCancelSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
})
