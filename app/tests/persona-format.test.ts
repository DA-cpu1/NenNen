/**
 * 分区人设互转（T05②，shared/persona-format.ts）的固定输入检查：
 * 拼接与拆分是「同一格式的两头」，最重要的性质是往返稳定——
 * 分区保存、重新打开还在分区模式，各框内容一字不差；
 * 而旧数据（T04 占位文本）和用户随手写的【】不会被误拆。
 */
import { describe, expect, it } from 'vitest'
import {
  PERSONA_SECTION_TITLES,
  emptyPersonaSections,
  personaFromSections,
  personaSectionsAllEmpty,
  sectionsFromPersona,
  type PersonaSections,
} from '../src/shared/persona-format'

/** 一组真实感的固定输入：三个分区都有内容 */
const sample: PersonaSections = {
  core: '认真维护自己的幻想小世界；在亲近的人面前会放松，也有自己的判断与坚持。',
  speech: '用自然中文，按情境选择简短直说或郑重的小宣布；口头禅不必每句出现。',
  background: '沿用动画版角色；暂不指定剧情时期，不把原作事件当成与用户的共同经历。',
}

describe('personaFromSections 拼接', () => {
  it('三块都有内容：拼出三段带标题、空行分隔的正文', () => {
    const text = personaFromSections(sample)
    expect(text).toBe(
      [
        `${PERSONA_SECTION_TITLES[0]}\n${sample.core}`,
        `${PERSONA_SECTION_TITLES[1]}\n${sample.speech}`,
        `${PERSONA_SECTION_TITLES[2]}\n${sample.background}`,
      ].join('\n\n'),
    )
  })

  it('空分区也保留标题：保证拆回时仍是分区模式', () => {
    const text = personaFromSections({ ...sample, background: '' })
    // 第三段标题在、内容空——下次拆回不至于整段退化为完整文本模式
    expect(text).toContain(PERSONA_SECTION_TITLES[2])
    expect(sectionsFromPersona(text).structured).toBe(true)
  })

  it('内容首尾空白被去掉，中间的空行原样保留；空分区只剩一行标题', () => {
    const text = personaFromSections({
      ...emptyPersonaSections(),
      core: '  第一行\n\n第三行  ',
    })
    expect(text).toBe(
      `${PERSONA_SECTION_TITLES[0]}\n第一行\n\n第三行` +
        `\n\n${PERSONA_SECTION_TITLES[1]}\n\n${PERSONA_SECTION_TITLES[2]}`,
    )
  })
})

describe('sectionsFromPersona 拆分', () => {
  it('标准格式拆回三块，内容一字不差', () => {
    const parsed = sectionsFromPersona(personaFromSections(sample))
    expect(parsed.structured).toBe(true)
    expect(parsed.sections).toEqual(sample)
    expect(parsed.fullText).toBe('')
  })

  it('往返稳定：拆回再拼，得到同一段文本', () => {
    const once = personaFromSections(sample)
    const round = personaFromSections(sectionsFromPersona(once).sections)
    expect(round).toBe(once)
  })

  it('T04 旧占位文本（无标题）按完整文本原样返回', () => {
    const old = '（占位人设：T03 正式角色卡在 T06 接入）'
    const parsed = sectionsFromPersona(old)
    expect(parsed.structured).toBe(false)
    expect(parsed.fullText).toBe(old)
    expect(parsed.sections).toEqual(emptyPersonaSections())
  })

  it('标题行前后有空白仍认得（手写/换行差异不致命）', () => {
    const text = `${PERSONA_SECTION_TITLES[0]}\n甲\n  ${PERSONA_SECTION_TITLES[1]}  \n乙\n${PERSONA_SECTION_TITLES[2]}\n丙`
    expect(sectionsFromPersona(text).sections).toEqual({
      core: '甲',
      speech: '乙',
      background: '丙',
    })
  })

  it('只凑齐部分标题不算标准格式（防用户随手【】被误拆）', () => {
    const partial = `随便写的笔记\n${PERSONA_SECTION_TITLES[0]}\n像标题但只有这一个`
    const parsed = sectionsFromPersona(partial)
    expect(parsed.structured).toBe(false)
    expect(parsed.fullText).toBe(partial)
  })

  it('标题乱序不算标准格式', () => {
    const reordered = `${PERSONA_SECTION_TITLES[1]}\n乙\n${PERSONA_SECTION_TITLES[0]}\n甲\n${PERSONA_SECTION_TITLES[2]}\n丙`
    expect(sectionsFromPersona(reordered).structured).toBe(false)
  })

  it('标题粘着别的字不算标题行', () => {
    const glued = `${PERSONA_SECTION_TITLES[0]}就是这样\n乙\n${PERSONA_SECTION_TITLES[1]}\n丙\n${PERSONA_SECTION_TITLES[2]}\n丁`
    expect(sectionsFromPersona(glued).structured).toBe(false)
  })

  it('空文本按完整文本处理，不抛错', () => {
    const parsed = sectionsFromPersona('')
    expect(parsed.structured).toBe(false)
    expect(parsed.fullText).toBe('')
  })
})

describe('personaSectionsAllEmpty 全空判断', () => {
  it('三块都空（含纯空白）返回 true', () => {
    expect(personaSectionsAllEmpty(emptyPersonaSections())).toBe(true)
    expect(
      personaSectionsAllEmpty({ core: '  \n ', speech: '', background: '\t' }),
    ).toBe(true)
  })

  it('任何一块有内容返回 false', () => {
    expect(personaSectionsAllEmpty({ ...emptyPersonaSections(), speech: '有一句' })).toBe(false)
  })
})
