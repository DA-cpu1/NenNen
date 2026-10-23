/**
 * 「应用 ↔ Agent」的接口约定（04 §3）。这份文件只立约定（类型），
 * 不含实现：T04 阶段先把「将来聊天怎么调用」的合同签好，防止 T06
 * 开工时接口凭空长出来、和这里对不上。run() 的真正实现在 T06
 * （完整聊天：流式回复、工具调用、预算与超时）。
 *
 * 它是草图不是现成框架 API——04 §3 原文：实现时按所安装版本的
 * eve / AI SDK 官方文档适配，不虚构上游接口（03 §3）。
 */

/** 一次「用户发消息、角色回一轮」的输入 */
export type TurnInput = {
  /** 唯一请求编号：重试沿用同一个号，数据库靠它防重复写（05 §5） */
  requestId: string
  /** 应用会话 ID：后端据此解析角色，不能信任模型自选角色（04 §4） */
  conversationId: string
  /** 这条用户消息的 ID */
  userMessageId: string
}

/**
 * 一轮流式输出的片段（TurnEvent = 回合事件）。
 * 「流式」指回复不是憋成一整段再给，而是一小段一小段陆续到达；
 * 每小段是一个 'text' 事件。界面边收边显示，像打字机。
 */
export type TurnEvent =
  | { type: 'text'; delta: string }
  /** 工具执行中的状态提示（如「正在保存称呼」），给界面显示进度 */
  | { type: 'tool-status'; label: string }
  /** 一轮完整结束：回复消息已落库，messageId 是它的 ID */
  | { type: 'done'; messageId: string }
  /** 失败结束：code 是错误码；retryable 告诉界面「重试」按钮能不能亮 */
  | { type: 'failed'; code: string; retryable: boolean }

/**
 * 聊天运行时的对外接口。AsyncIterable<TurnEvent> 的意思是：
 * run() 返回一个「事件流」，调用方用 for await...of 逐个接收事件——
 * 天然支持流式显示与中途取消（signal 一触发，流就结束）。
 */
export interface CompanionRuntime {
  /** 跑一轮对话：输入用户消息，流出回复事件 */
  run(input: TurnInput, signal: AbortSignal): AsyncIterable<TurnEvent>
  /**
   * 作废某会话的运行上下文：纠正/忘记后调用，淘汰旧缓存并用干净
   * 上下文重建（04 §5 rebuild_runtime_context 的入口）
   */
  invalidateContext(conversationId: string): Promise<void>
}
