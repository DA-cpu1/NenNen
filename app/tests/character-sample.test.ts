/** 角色样稿接线检查：完整文字、原创问答顺序、新库入库与旧库保护。 */
import { describe, expect, it } from 'vitest'
import { openCompanionDatabase } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { getCharacterOverview } from '../src/data/character-edit'
import { COMMON_FACT_RULES, RIKKA_SAMPLE } from '../src/shared/character-sample'

describe('当前角色候选样稿', () => {
  it('保留完整人设与共同规则，七个场景十三对问答按原顺序独立保存', () => {
    expect(RIKKA_SAMPLE.personaText).toContain('不必把他套进原作的关系')
    expect(RIKKA_SAMPLE.personaText).toContain('不代表别的领域你也不懂')
    expect(RIKKA_SAMPLE.personaText).toContain('你懂的事')
    expect(COMMON_FACT_RULES).toContain('朋友的经历不是用户的经历')
    expect(COMMON_FACT_RULES).toContain('当前未提供相应工具时')
    expect(COMMON_FACT_RULES).toContain('你知道的比设定里写的多')
    expect(COMMON_FACT_RULES).not.toContain('<!--')
    expect(RIKKA_SAMPLE.dialogueExamples).toHaveLength(13)
    expect(new Set(RIKKA_SAMPLE.dialogueExamples.map((example) => example.scene)).size).toBe(6)
    expect(RIKKA_SAMPLE.dialogueExamples[0].user).toBe('窗外那片云很像一条龙。')
    expect(RIKKA_SAMPLE.dialogueExamples[12].character).toBe('契约也算数。\n但刚才，是我自己想说的。')
  })

  it('新库一次存齐样稿，重入时不覆盖旧人设和原示例', () => {
    const database = openCompanionDatabase(':memory:')
    try {
      runMigrations(database.sqlite)
      initializeFirstCharacter(database.db, { name: '六花', ...RIKKA_SAMPLE, timezone: 'Asia/Hong_Kong' })
      const first = getCharacterOverview(database.db)
      expect(first?.activeVersion?.personaText).toBe(RIKKA_SAMPLE.personaText)
      expect(first?.activeVersion?.dialogueExamples).toEqual(RIKKA_SAMPLE.dialogueExamples)
      const repeated = initializeFirstCharacter(database.db, {
        name: '其他名字', personaText: '不得覆盖', initialRelationship: '陌生人', timezone: 'UTC',
      })
      expect(repeated.created).toBe(false)
      expect(getCharacterOverview(database.db)).toEqual(first)
    } finally { database.close() }
  })
})
