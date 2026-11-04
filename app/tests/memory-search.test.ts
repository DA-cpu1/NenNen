/** 用少量固定文字检查关键词精确命中、排序和上限；完整 A10 语料另行验收。 */
import { describe, expect, it } from 'vitest'
import type { Memory } from '../src/data/memories'
import { searchMemories } from '../src/memory/search'

/** 造一条已由数据层筛过的有效记忆。 */
function memory(id: string, content: string, validFrom = 1): Memory {
  return {
    id, scope: 'character', characterId: 'char', kind: 'fact', memoryKey: null,
    content, origin: 'user_explicit', status: 'active', revision: 1, supersedesId: null,
    validFrom, expiresAt: null, createdAt: validFrom, updatedAt: validFrom,
  }
}

describe('中文关键词检索', () => {
  it('分词后精确命中，匹配多的优先，同分时按时间从新到旧', () => {
    const rows = [memory('old', '喜欢咖啡'), memory('new', '不喝咖啡', 2), memory('exact', '喜欢咖啡和奶茶')]
    expect(searchMemories(rows, '咖啡和奶茶是什么关系').map((row) => row.id)).toEqual(['exact', 'new', 'old'])
    expect(searchMemories(rows, '咖').map((row) => row.id)).toEqual([])
    expect(searchMemories(rows, '你还记得以前说了什么吗')).toEqual([])
  })

  it('输入的全角字母与大小写不影响匹配', () => {
    expect(searchMemories([memory('one', '项目使用 TypeScript')], 'ＴＹＰＥＳＣＲＩＰＴ')).toMatchObject([{ id: 'one' }])
  })

  it('最多八条，工具可以进一步缩短，超出字节预算的单条可跳过', () => {
    const rows = Array.from({ length: 10 }, (_, index) => memory(`mem-${index}`, '喜欢咖啡', index))
    expect(searchMemories(rows, '咖啡', 100)).toHaveLength(8)
    expect(searchMemories(rows, '咖啡', 2)).toMatchObject([{ id: 'mem-9' }, { id: 'mem-8' }])
    const long = memory('long', `咖啡。${'测试正文'.repeat(150)}`, 100)
    expect(searchMemories([long, ...rows], '咖啡')).toMatchObject(searchMemories(rows, '咖啡'))
    const medium = Array.from({ length: 4 }, (_, index) => memory(`m${index}`, `咖啡。${'测试正文'.repeat(35)}`, index))
    expect(searchMemories(medium, '咖啡')).toHaveLength(2)
  })
})
