/** 先保存记忆变更，再取消旧工作；等本地缓存清理完成才给成功回执。 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { listManagedMemories, mutateMemory, previewMemoryDeletion, type MemoryMutation, type MemoryMutationContext } from '../data/memory-management'
import { getFirstCharacter } from '../data/character-init'
import { getFormalConversation } from '../data/conversations'
import type { MemoryChange, MemoryChangeReceipt, MemoryTarget } from '../shared/memory-management'

/** 使用实际会话身份的聊天工具修改。服务层先复查原话和工具许可。 */
export type ChatMemoryChange = { memoryId: string; expectedRevision: number } & (
  { action: 'correct'; content: string } | { action: 'forget' }
)

/** 数据已保存后单独等待清理。聊天用它通过事件流发最终回执。 */
export interface AppliedMemoryChange {
  receipt: MemoryChangeReceipt
  cleaned: Promise<void>
}

/**
 * 创建记忆管理服务，负责串行清理，以及清理失败后保留受影响会话的暂停状态。
 * @param db 后台 SQLite 连接
 * @param invalidate 只通知依赖旧版本的聊天和整理
 * @param clean 删除已失效的框架运行文件并收尾数据库日志
 * @returns 管理页和聊天工具共用的入口
 */
export function createMemoryManagement(
  db: BetterSQLite3Database,
  invalidate: (conversationIds: readonly string[]) => void,
  clean: () => Promise<void>,
) {
  const blocked = new Set<string>()
  let cleaning: Promise<void> | undefined

  /** 清理失败后可以重试同一份收尾，不重复删记忆或原话。 */
  function retryCleanup(): Promise<void> {
    if (cleaning) return cleaning
    if (blocked.size === 0) return Promise.resolve()
    cleaning = Promise.resolve().then(clean).then(() => {
      blocked.clear()
    }, () => {
      throw new Error('MEMORY_CLEANUP_FAILED')
    }).finally(() => { cleaning = undefined })
    return cleaning
  }

  /** 角色由应用选定。管理页不接受可替换的会话或角色编号。 */
  function activeCharacter() {
    const character = getFirstCharacter(db)
    const conversation = character && getFormalConversation(db, character.id)
    if (!character || !conversation) throw new Error('NOT_FOUND')
    return { character, conversation }
  }

  /** 数据事务失败时没有需要取消的运行；只有落库完成才通知等待方。 */
  function apply(context: MemoryMutationContext, change: MemoryMutation): AppliedMemoryChange {
    if (cleaning) throw new Error('MEMORY_CLEANUP_PENDING')
    const result = mutateMemory(db, context, change, Date.now())
    for (const id of result.conversationIds) blocked.add(id)
    if (result.conversationIds.length) invalidate(result.conversationIds)
    return { receipt: result.receipt, cleaned: retryCleanup() }
  }

  return {
    /** 管理页读取当前资料、旧值及来源，另外告知是否还有待清理事项。 */
    list: () => ({ memories: listManagedMemories(db, activeCharacter().character.id, Date.now()), cleanupPending: blocked.size > 0 }),
    /** 只读确认清单，取消确认不会写入任何数据。 */
    previewDeletion: (target: MemoryTarget) => previewMemoryDeletion(db, activeCharacter().character.id, target),
    /** 只暂停受影响的会话。 */
    isBlocked: (conversationId: string) => blocked.has(conversationId),
    retryCleanup,
    /** 页面请求可在原编号重试时读回已有回执，仍需等清理完成。 */
    change: async (change: MemoryChange): Promise<MemoryChangeReceipt> => {
      const { conversation } = activeCharacter()
      const result = apply({ conversationId: conversation.id, requestId: change.requestId }, change)
      await result.cleaned
      return result.receipt
    },
    /** 模型只能对本轮的正式角色纠正，忘记时保留聊天原话。 */
    changeFromChat: (conversationId: string, requestMessageId: string, change: ChatMemoryChange): AppliedMemoryChange => {
      return apply({ conversationId, requestMessageId },
        change.action === 'forget' ? { ...change, deleteSources: false } : change)
    },
  }
}
