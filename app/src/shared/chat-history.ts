/** 历史读取的请求和回包形状；界面只拿消息资料，不接触数据库连接或框架凭据。 */
import { z } from 'zod'

/** 一次最多读 100 条；beforeSeq 是「只读这条之前的消息」的翻页边界。 */
export const chatHistoryQuerySchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** 服务校验后交给数据层的查询参数。 */
export type ChatHistoryQuery = z.infer<typeof chatHistoryQuerySchema>

/** 历史列表里的消息；保留完成状态和原用户关联，以便展示半截回复与重试版本。 */
export interface ChatMessage {
  id: string
  conversationId: string
  seq: number
  role: 'user' | 'assistant' | 'proactive'
  content: string
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  clientRequestId: string | null
  replyToId: string | null
  excludedFromContext: boolean
  createdAt: number
}

/** 每页消息按从旧到新排列；hasMore 表示本页之前还有历史。 */
export interface ChatHistoryPage {
  conversationId: string
  characterId: string
  messages: ChatMessage[]
  hasMore: boolean
}
