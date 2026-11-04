/** 固定 A10 的虚构原话、已知记忆和提问，通过真实数据层测量前八条召回。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { listCurrentMemories, saveCharacterMemory, type Memory } from '../src/data/memories'
import { runMigrations } from '../src/data/migrations'
import { characters, conversations, messages } from '../src/data/tables'
import { searchMemories } from '../src/memory/search'

const cases = [
  ['我在做一款桌面陪伴应用，角色会常驻桌面。', '用户正在开发桌面陪伴应用。', '能帮我捋捋桌面小伙伴那个项目的进度吗？'],
  ['咖啡我一般喝美式，牛奶另放。', '用户通常点美式咖啡，牛奶另放。', '咖啡店里我平常会点哪一款？'],
  ['我妈下个月来香港，我要带她去坐电车。', '用户打算带母亲在香港坐电车。', '上次说家里人来香港，我打算怎么带她玩来着？'],
  ['我家有只橘猫叫南瓜。', '用户的橘猫名叫南瓜。', '我养的那只猫咪叫什么来着？'],
  ['每个周二晚上我练羽毛球。', '用户周二晚上打羽毛球。', '羽毛球是固定星期几约的？'],
  ['工作日午餐我基本都在园区食堂吃。', '用户工作日常在园区食堂吃午饭。', '上班那几天，食堂是我午休常去的地方吗？'],
  ['我最近在复习 TypeScript 的类型系统。', '用户近期在复习 TypeScript 的类型系统。', '我这阵子主要在补哪块 TypeScript 知识？'],
  ['我的新相机拿来拍鸟比较多。', '用户的新相机主要用来拍鸟。', '你还记得我入手相机以后最常拍什么吗？'],
  ['我不爱喝带珍珠的奶茶。', '用户点奶茶时不喜欢加珍珠。', '帮我回忆一下，买奶茶要避开哪种小料？'],
  ['我给租的房子添了个落地灯。', '用户给租住的房子添置了落地灯。', '租的那套房最近新买了什么灯具？'],
  ['我睡前在看《银河系漫游指南》。', '用户睡前阅读《银河系漫游指南》。', '床边那本《银河系漫游指南》是我什么时候看的？'],
  ['我周末想去海边散步，打算从码头出发。', '用户计划周末去海边散步，从码头出发。', '去海边走走那次，原定从哪里开始？'],
  ['我买了个降噪耳机，通勤时想听播客。', '用户准备通勤时用降噪耳机听播客。', '我在路上听播客，之前为此买了什么装备？'],
  ['我四月份去杭州看朋友。', '用户计划四月去杭州探望朋友。', '跟杭州的老朋友约的是哪个月？'],
  ['我不能吃花生，吃了会过敏。', '用户对花生过敏。', '那种我说碰不得的坚果是什么？'],
  ['键盘我喜欢安静一点的，办公不吵。', '用户办公喜欢用声音小的键盘。', '给办公室挑键盘时我在意哪个方面？'],
  ['我在存钱，想年底换一台笔记本电脑。', '用户打算年底换笔记本电脑，正在存钱。', '我攒的那笔钱是预备用来买什么的？'],
  ['我想用番茄钟安排复习，每次先学二十五分钟。', '用户复习打算用番茄钟，每次先学二十五分钟。', '用番茄钟学东西时，一段应该多长？'],
  ['以后我吐槽工作时，请先听我说完。', '用户希望吐槽工作时先得到倾听。', '我因为工作烦躁的时候，更想你怎么陪我？'],
  ['我一坐长途大巴就晕车。', '用户坐长途大巴容易晕车。', '选长途交通工具时，哪一种我坐着容易不舒服？'],
] as const

const unrelatedQuestions = [
  '火星为什么看起来是红色的？', '怎么分辨水彩和水粉？', '灯塔的透镜有什么作用？', '教我画一艘帆船。',
  '洗衣机脱水时为什么抖动？', '巨杉能活多久？', '如何画一个规则的五角星？', '月全食一般持续多久？',
  '邮票上的齿孔是做什么用的？', '鲸鱼怎么换气？',
]
const now = 1_740_000_000_000
let companion: CompanionDb
let rows: Memory[]
const sourceByMemoryId = new Map<string, string>()

beforeAll(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  const { db } = companion
  db.insert(characters).values({ id: 'a10', name: '虚构角色', createdAt: now, updatedAt: now }).run()
  db.insert(conversations).values({ id: 'chat', characterId: 'a10', createdAt: now, lastMessageAt: now }).run()
  cases.forEach(([original, content], index) => {
    const messageId = `a10-${index + 1}`
    const createdAt = now + index
    db.insert(messages).values({
      id: messageId, conversationId: 'chat', seq: index + 1, role: 'user', content: original,
      status: 'completed', createdAt,
    }).run()
    const saved = saveCharacterMemory(db, {
      conversationId: 'chat', kind: 'fact', memoryKey: null, content, origin: 'user_explicit',
      sourceMessageIds: [messageId], expiresAt: null, now: createdAt,
    })
    if (saved.status !== 'saved') throw new Error(`A10 测试记忆未保存 ${messageId}`)
  })
  // 直接核对数据库的来源关系，命中同主题但不同原话的记录也算误召回。
  const links = companion.sqlite.prepare('SELECT memory_id, message_id FROM memory_sources').all()
  for (const link of links as Array<{ memory_id: string; message_id: string }>) {
    sourceByMemoryId.set(link.memory_id, link.message_id)
  }
  rows = listCurrentMemories(db, 'a10', now + cases.length)
})

afterAll(() => companion.close())

describe('A10 固定语料', () => {
  it('二十个中文改写问句至少召回十八条正确来源，并记录误召回', () => {
    let correct = 0
    const missed: number[] = []
    const falseHits: Array<{ question: number; sources: Array<string | undefined> }> = []
    cases.forEach(([, , question], index) => {
      const expected = `a10-${index + 1}`
      const sources = searchMemories(rows, question).map(({ id }) => sourceByMemoryId.get(id))
      if (sources.includes(expected)) correct += 1
      else missed.push(index + 1)
      const otherSources = sources.filter((source) => source !== expected)
      if (otherSources.length) falseHits.push({ question: index + 1, sources: otherSources })
    })
    console.info('A10 改写问句', JSON.stringify({ correct, total: cases.length, missed, falseHits }))
    expect(correct).toBeGreaterThanOrEqual(18)
  })

  it('十个无关问句不提供记忆资料', () => {
    const falseHits = unrelatedQuestions.flatMap((question, index) => {
      const sources = searchMemories(rows, question).map(({ id }) => sourceByMemoryId.get(id))
      return sources.length ? [{ question: index + 1, sources }] : []
    })
    console.info('A10 无关问句', JSON.stringify({ total: unrelatedQuestions.length, falseHits }))
    expect(falseHits).toEqual([])
  })
})
