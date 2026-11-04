/** 把可作为证据的用户原话切成有边界的整理批次，保留原消息编号。 */
import { Buffer } from 'node:buffer'
import type { ContextMessage } from '../agent/turn-context'

const characterLimit = 12_000
// 中文按字节保守估算更大。先给候选结构、提示规则、相关旧记忆和回复留出余量。
const defaultTextBytes = 28_000

/** 顺序号和已读码点数。offset 为 0 表示位置已越过这条消息。 */
export interface MemoryPosition { seq: number; offset: number }

/** 原话可只取一段，但候选引用的始终是原消息号。 */
export interface MemoryBatchSource { id: string; seq: number; content: string; createdAt: number }

/** 固定可送往整理模型的原话及结束书签；成功提交后才移动书签。 */
export interface MemoryBatch {
  start: MemoryPosition
  end: MemoryPosition
  sources: MemoryBatchSource[]
}

/**
 * 按顺序选用户原话。角色回复的想象不能成为用户资料，既不摘录也不作为依据。
 * @param messages 已通过正式会话和排除过滤的消息，按顺序号从小到大
 * @param cursor 上一批成功保存的书签；部分原话从已读码点继续
 * @param byteLimit 原话和来源编号的 JSON 字节上限，测试可注入小值
 * @returns 最多 12,000 码点的一批原话，无有效来源时为空
 */
export function planMemoryBatch(
  messages: readonly ContextMessage[], cursor: MemoryPosition, byteLimit = defaultTextBytes,
): MemoryBatch | null {
  let remainingCharacters = characterLimit
  let remainingBytes = byteLimit - 2 // JSON 数组的方括号。
  let batch: MemoryBatch | null = null
  for (const message of messages) {
    if (message.role !== 'user' || message.seq < cursor.seq || (message.seq === cursor.seq && cursor.offset === 0)) continue
    const points = [...message.content]
    const start = { seq: message.seq, offset: message.seq === cursor.seq ? cursor.offset : 0 }
    const source = { id: message.id, seq: message.seq, content: '', createdAt: message.createdAt }
    // 短消息很多时编号也占空间；空正文之外再留一字节给相邻项目的逗号。
    remainingBytes -= Buffer.byteLength(JSON.stringify(source), 'utf8') + (batch ? 1 : 0)
    let endIndex = start.offset
    for (; endIndex < points.length && remainingCharacters > 0; endIndex += 1) {
      // 去掉 JSON 字符串两侧引号，保留换行、引号等字符转义后实际需要的字节。
      const bytes = Buffer.byteLength(JSON.stringify(points[endIndex]), 'utf8') - 2
      if (bytes > remainingBytes) break
      remainingCharacters -= 1
      remainingBytes -= bytes
    }
    if (endIndex === start.offset) break
    const end = { seq: message.seq, offset: endIndex < points.length ? endIndex : 0 }
    batch ??= { start, end, sources: [] }
    batch.end = end
    batch.sources.push({ ...source, content: points.slice(start.offset, endIndex).join('') })
    if (end.offset || remainingCharacters === 0 || remainingBytes === 0) break
  }
  return batch
}
