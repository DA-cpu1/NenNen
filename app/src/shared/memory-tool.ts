/** 约定 eve 向本机业务后台查询记忆时的消息格式，模型只填写工具参数。 */
import { z } from 'zod'
import type { MemoryMatch } from '../memory/search'

/** 只有在本机后台有正在运行的正式回合时，才使用这个内部路径。 */
export const memoryToolPath = '/internal/memory-tool'

/** 检索参数只接受问句和条数，拒绝模型添加角色编号等自选范围。 */
export const searchMemoriesInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(8).optional(),
})

/** 外层会话号由 eve 读取自身运行身份后填写，不出现在给模型的参数里。 */
export const memoryToolRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  tool: z.literal('search_memories'),
  input: searchMemoriesInputSchema,
})

/** 后台复查后的内部请求和结果。 */
export type MemoryToolRequest = z.infer<typeof memoryToolRequestSchema>
export type MemoryToolResult =
  | { ok: true; memories: MemoryMatch[] }
  | { ok: false; code: 'NOT_FOUND' | 'CANCELLED' | 'BUDGET_EXCEEDED' | 'STORAGE_UNAVAILABLE'; message: string; retryable: boolean }
