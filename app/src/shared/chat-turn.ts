/**
 * 聊天回合在「界面 ↔ 后台」之间的请求与事件契约。
 * 请求体用 zod 在服务端把关；事件类型描述 SSE 流里每一帧的形状。
 * 这层只定义「线上长什么样」，不引用 Agent 层的实现（分层：shared 谁都可以
 * import，反过来 agent/service 引 shared，不能让 shared 反过来依赖它们）。
 */
import { z } from 'zod'
import { dialogueExampleSchema, type DialogueExample } from './character-schema'
import { personaFromSections, personaSectionsAllEmpty } from './persona-format'

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

/** SSE 流里的一帧。saved 是首帧：告诉界面用户消息已落库及其编号与会话编号。 */
export type SseTurnEvent =
  | { type: 'saved'; userMessageId: string; conversationId: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; replyId: string }
  | { type: 'cancelled' }
  | { type: 'failed'; code: string }

/** 取消当前回合的请求体：按会话取消，一个会话同时最多一个活动回合。 */
export const chatTurnCancelSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
})

/** 已归一的试聊草稿人设：正文已由「分区/全文」二选一拼好，关系非空。 */
export interface PreviewPersonaDraft {
  personaText: string
  initialRelationship: string
  userNickname: string | null
  dialogueExamples: DialogueExample[]
}

/** 试聊回合请求：正文 + 编辑页当前草稿；会话由后台按角色解析，界面不指定。 */
export const previewTurnRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  draft: z.strictObject({
    /** 分区人设（三段）与完整全文二选一，规则与保存人设版本一致。 */
    personaSections: z.strictObject({ core: z.string(), speech: z.string(), background: z.string() }).optional(),
    personaFullText: z.string().optional(),
    initialRelationship: z.string().refine((value) => value.trim() !== '', { message: '初始关系不能为空' }),
    userNickname: z.string().nullable().optional(),
    dialogueExamples: z.array(dialogueExampleSchema).max(20).optional(),
  }),
})

/** 服务端校验后的试聊请求。 */
export type PreviewTurnRequest = z.infer<typeof previewTurnRequestSchema>

/**
 * 把试聊请求里的草稿归一成人设正文；分区/全文二选一的规则与保存路径
 * 完全一致——试聊看到的和保存后看到的必须是同一份拼法。
 * @param request 已过 zod 的试聊请求
 * @returns 归一后的草稿；二选一规则不满足或内容全空时返回 undefined
 */
export function resolvePreviewDraft(request: PreviewTurnRequest): PreviewPersonaDraft | undefined {
  const sections = request.draft.personaSections
  const fullText = request.draft.personaFullText
  if ((sections !== undefined) === (fullText !== undefined)) return undefined
  let personaText: string
  if (sections !== undefined) {
    if (personaSectionsAllEmpty(sections)) return undefined
    personaText = personaFromSections(sections)
  } else {
    personaText = (fullText ?? '').trim()
    if (personaText === '') return undefined
  }
  return {
    personaText,
    initialRelationship: request.draft.initialRelationship,
    userNickname: request.draft.userNickname ?? null,
    dialogueExamples: request.draft.dialogueExamples ?? [],
  }
}
