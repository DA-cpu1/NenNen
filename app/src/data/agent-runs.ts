/**
 * 给每次真实模型尝试单独记账；同一句用户消息重试两次，也要留下两次用量。
 * 本文件只接收调用方取得的实际用量或保守估算，不读取正文、不在错误码里保存提示词。
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { agentRuns, characterVersions, conversations } from './tables'

/** 角色和触发类型由会话决定；人设版本必须是该角色在本轮实际使用的版本。 */
export interface StartAgentRunInput {
  conversationId: string
  characterVersionId: string | null
  model: string
  provider: string
  now?: number
}

/** 供应商没给用量时，调用方必须传保守估算并标 estimated=true。 */
export interface FinishAgentRunInput {
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  usage: { inputTokens: number; outputTokens: number; estimated: boolean }
  errorCode?: string
  now?: number
}

/**
 * 登记即将发生的模型尝试，从数据库会话推导角色与正式/试聊身份。
 * @param db 后台数据库连接
 * @param input 会话、实际人设版本、模型和供应商及可选检查时间
 * @returns 新的 running 记录；每次真实尝试使用独立编号
 * @throws E_INVALID_RUN 模型或供应商为空；E_CONVERSATION_NOT_FOUND 会话不存在；
 * E_VERSION_NOT_ALLOWED 正式聊天没给人设版本，或版本不属于该角色
 */
export function startAgentRun(db: BetterSQLite3Database, input: StartAgentRunInput) {
  if (!input.model.trim() || !input.provider.trim()) throw new Error('E_INVALID_RUN')
  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations)
      .where(eq(conversations.id, input.conversationId)).get()
    if (!conversation) throw new Error('E_CONVERSATION_NOT_FOUND')
    // 试聊草稿尚未保存成版本可以留空；正式聊天必须能追溯实际使用的人设。
    if (conversation.mode === 'normal' && input.characterVersionId === null) {
      throw new Error('E_VERSION_NOT_ALLOWED')
    }
    if (input.characterVersionId !== null) {
      const version = tx.select({ id: characterVersions.id }).from(characterVersions).where(and(
        eq(characterVersions.id, input.characterVersionId),
        eq(characterVersions.characterId, conversation.characterId),
      )).get()
      if (!version) throw new Error('E_VERSION_NOT_ALLOWED')
    }
    return tx.insert(agentRuns).values({
      id: `run-${randomUUID()}`, conversationId: conversation.id,
      characterId: conversation.characterId, characterVersionId: input.characterVersionId,
      triggerType: conversation.mode === 'preview' ? 'preview' : 'chat',
      model: input.model, provider: input.provider, status: 'running',
      startedAt: input.now ?? Date.now(),
    }).returning().get()
  })
}

/**
 * 保存结束状态和用量；重复结束通知原样复用，不把同一次消耗再记一遍。
 * @param db 后台数据库连接
 * @param input 运行编号、结果、实际或估算用量、固定错误码及可选检查时间
 * @returns 结束后的运行记录
 * @throws E_INVALID_USAGE 非整数/负数用量或把未知估成零；E_INVALID_ERROR_CODE 错误码含正文；
 * E_RUN_NOT_FOUND 运行不存在；E_RUN_ALREADY_FINISHED 已结束却收到冲突结果
 */
export function finishAgentRun(db: BetterSQLite3Database, input: FinishAgentRunInput) {
  const { inputTokens, outputTokens, estimated } = input.usage
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)
    || inputTokens < 0 || outputTokens < 0 || (estimated && inputTokens + outputTokens === 0)) {
    throw new Error('E_INVALID_USAGE')
  }
  if (input.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)) {
    throw new Error('E_INVALID_ERROR_CODE')
  }
  return db.transaction((tx) => {
    const run = tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).get()
    if (!run) throw new Error('E_RUN_NOT_FOUND')
    const result = {
      status: input.status, inputTokens, outputTokens, usageEstimated: estimated ? 1 : 0,
      errorCode: input.errorCode ?? null,
    }
    if (run.status !== 'running') {
      // 重复到达的同一结果可复用，第一次的结束时间保持不变。
      if (run.status === result.status && run.inputTokens === inputTokens
        && run.outputTokens === outputTokens && run.usageEstimated === result.usageEstimated
        && run.errorCode === result.errorCode) return run
      throw new Error('E_RUN_ALREADY_FINISHED')
    }
    return tx.update(agentRuns).set({ ...result, finishedAt: input.now ?? Date.now() })
      .where(eq(agentRuns.id, run.id)).returning().get()!
  })
}
