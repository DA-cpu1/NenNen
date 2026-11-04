/** 用中文分词找相关记忆，按匹配和时间选出一小段能交给模型的资料。 */
import { Buffer } from 'node:buffer'
import type { Memory } from '../data/memories'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const commonWords = new Set([
  '什么', '怎么', '如何', '哪个', '哪些', '有没有', '是否', '之前', '以前', '最近', '现在',
  '目前', '时候', '记得', '知道', '那个', '这个', '我们', '你们', '他们', '用户', '希望',
])
const resultLimit = 8
const estimatedTokenLimit = 1_500

/** 检索结果只带回答所需内容和来源属性，原话和数据库内部状态留在本地。 */
export type MemoryMatch = Pick<Memory, 'id' | 'content' | 'scope' | 'origin' | 'validFrom' | 'expiresAt' | 'revision'>

/** 中文原文常没有空格。让系统词典切词，统一全角和大小写，再丢掉常见问法。 */
function keywords(text: string): Set<string> {
  const words = new Set<string>()
  for (const { segment, isWordLike } of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    // 「做」「喝」等单字在许多话题都出现，单凭它们会把无关记忆带进回复。
    if (isWordLike && !/^\p{Script=Han}$/u.test(segment) && !commonWords.has(segment)) words.add(segment)
  }
  return words
}

/**
 * 只比较分词后完全相同的关键词；命中多的优先，同分时优先当前有效时间较新的记忆。
 * @param memories 由 SQLite 先按当前角色、共享范围和时效过滤后的记忆
 * @param query 用户提问或工具给出的搜索词
 * @param limit 最多返回几条，不能超过产品上限 8
 * @returns 排序后可带进模型的结果，完全没有匹配时为空
 */
export function searchMemories(memories: readonly Memory[], query: string, limit = resultLimit): MemoryMatch[] {
  const queryWords = keywords(query)
  if (queryWords.size === 0 || !Number.isInteger(limit) || limit < 1) return []

  const matches = memories.flatMap((memory) => {
    const words = keywords(memory.content)
    let score = 0
    for (const word of queryWords) {
      if (words.has(word)) score += 1
    }
    return score === 0 ? [] : [{ memory, score }]
  })
  matches.sort((a, b) => b.score - a.score || b.memory.validFrom - a.memory.validFrom ||
    a.memory.id.localeCompare(b.memory.id))

  const results: MemoryMatch[] = []
  for (const { memory } of matches) {
    if (results.length >= Math.min(limit, resultLimit)) break
    const { id, content, scope, origin, validFrom, expiresAt, revision } = memory
    const match = { id, content, scope, origin, validFrom, expiresAt, revision }
    // 用整个结果的 UTF-8 字节保守估算 token。单条太长时仍可选后面放得下的记忆。
    if (Buffer.byteLength(JSON.stringify([...results, match]), 'utf8') <= estimatedTokenLimit) results.push(match)
  }
  return results
}
