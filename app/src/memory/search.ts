/** 用中文分词找相关记忆，按匹配和时间选出一小段能交给模型的资料。 */
import { Buffer } from 'node:buffer'
import type { Memory } from '../data/memories'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const commonWords = new Set([
  '什么', '怎么', '如何', '哪个', '哪些', '有没有', '是否', '之前', '以前', '最近', '现在',
  '目前', '时候', '记得', '知道', '那个', '这个', '我们', '你们', '他们', '用户', '希望', '打算',
])
const commonHan = new Set('的一是了我你他她它们个这那有在着也就都吗呢吧很还最不没会可想说能要为来去给时用从和于对得地过后前什么怎样哪里多好叫')
const resultLimit = 8
const estimatedTokenLimit = 1_500

/** 检索结果只带回答所需内容和来源属性，原话和数据库内部状态留在本地。 */
export type MemoryMatch = Pick<Memory, 'id' | 'content' | 'scope' | 'origin' | 'validFrom' | 'expiresAt' | 'revision'>

interface RankedMemory { memory: Memory; score: number }

/** 中文原文常没有空格。让系统词典切词，统一全角和大小写，再丢掉常见问法。 */
function keywords(text: string): Set<string> {
  const words = new Set<string>()
  for (const { segment, isWordLike } of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    // 「做」「喝」等单字在许多话题都出现，单凭它们会把无关记忆带进回复。
    if (isWordLike && !/^\p{Script=Han}$/u.test(segment) && !commonWords.has(segment)) words.add(segment)
  }
  return words
}

/** 记录连续汉字中的相邻字对和单字，保留标点隔开的边界。 */
function hanEvidence(text: string): { characters: Set<string>; pairs: Set<string> } {
  const characters = new Set<string>()
  const pairs = new Set<string>()
  for (const [run] of text.normalize('NFKC').matchAll(/\p{Script=Han}+/gu)) {
    let previous = ''
    for (const character of run) {
      if (commonHan.has(character)) {
        previous = ''
        continue
      }
      characters.add(character)
      if (previous) pairs.add(previous + character)
      previous = character
    }
  }
  return { characters, pairs }
}

/**
 * 分词全无命中时比较原字，补回「咖啡」与「咖啡店」这类边界差异。
 * 一个散落的字很容易撞上无关记忆，只有两个不同的字都只出现在同一条记忆里时才计分。
 */
function matchHan(memories: readonly Memory[], query: string): RankedMemory[] {
  const queryEvidence = hanEvidence(query)
  const occurrences = new Map<string, number>()
  const rows = memories.map((memory) => {
    const evidence = hanEvidence(memory.content)
    for (const character of evidence.characters) {
      occurrences.set(character, (occurrences.get(character) ?? 0) + 1)
    }
    return { memory, ...evidence }
  })
  return rows.flatMap(({ memory, characters, pairs }) => {
    const pairHits = [...queryEvidence.pairs].filter((pair) => pairs.has(pair)).length
    const rareHits = [...queryEvidence.characters].filter((character) =>
      characters.has(character) && occurrences.get(character) === 1).length
    const score = pairHits * 2 + (rareHits >= 2 ? rareHits : 0)
    return score > 0 ? [{ memory, score }] : []
  })
}

/**
 * 优先比较精确词，完全没命中再比原字；同分时优先当前有效时间较新的记忆。
 * @param memories 由 SQLite 先按当前角色、共享范围和时效过滤后的记忆
 * @param query 用户提问或工具给出的搜索词
 * @param limit 最多返回几条，不能超过产品上限 8
 * @returns 排序后可带进模型的结果，完全没有匹配时为空
 */
export function searchMemories(memories: readonly Memory[], query: string, limit = resultLimit): MemoryMatch[] {
  const queryWords = keywords(query)
  if (!Number.isInteger(limit) || limit < 1) return []

  return takeMatches(rankMemories(memories, query, queryWords), limit)
}

/**
 * 正式聊天可固定带入稳定称呼，再用剩余位置补相关记忆。
 * @param memories 已按当前角色与时效筛过的 SQLite 记录
 * @param query 当前用户原话
 * @returns 与工具检索共用条数和大小限制的当轮资料
 */
export function selectContextMemories(memories: readonly Memory[], query: string): MemoryMatch[] {
  const preferredName = memories.find((memory) => memory.memoryKey === 'preferred_name' && memory.scope === 'character')
    ?? memories.find((memory) => memory.memoryKey === 'preferred_name')
  const related = rankMemories(memories.filter((memory) => memory.memoryKey !== 'preferred_name'), query, keywords(query))
  return takeMatches(preferredName ? [preferredName, ...related] : related, resultLimit)
}

/** 按匹配证据及时间排序，大小限制交给统一的选取步骤。 */
function rankMemories(memories: readonly Memory[], query: string, queryWords: Set<string>): Memory[] {
  const exactMatches = queryWords.size === 0 ? [] : memories.flatMap((memory) => {
    const words = keywords(memory.content)
    let score = 0
    for (const word of queryWords) {
      if (words.has(word)) score += 1
    }
    return score === 0 ? [] : [{ memory, score }]
  })
  const matches = exactMatches.length ? exactMatches : matchHan(memories, query)
  matches.sort((a, b) => b.score - a.score || b.memory.validFrom - a.memory.validFrom ||
    a.memory.id.localeCompare(b.memory.id))
  return matches.map(({ memory }) => memory)
}

/** 统一限制工具和聊天可携带的记忆条数及大小。 */
function takeMatches(memories: readonly Memory[], limit: number): MemoryMatch[] {
  const results: MemoryMatch[] = []
  for (const memory of memories) {
    if (results.length >= Math.min(limit, resultLimit)) break
    const { id, content, scope, origin, validFrom, expiresAt, revision } = memory
    const match = { id, content, scope, origin, validFrom, expiresAt, revision }
    // 用整个结果的 UTF-8 字节保守估算 token。单条太长时仍可选后面放得下的记忆。
    if (Buffer.byteLength(JSON.stringify([...results, match]), 'utf8') <= estimatedTokenLimit) results.push(match)
  }
  return results
}
