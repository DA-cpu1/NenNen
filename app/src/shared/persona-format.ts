/**
 * 分区人设 ↔ 纯文本 的互转小工具（T05 角色编辑页用，02 §1 填写项）。
 *
 * 为什么需要它：数据库的人设只存一列 personaText 纯文本（T04 定的结构，
 * T06 组装提示词时也直接用这段全文）；而编辑页想按「核心性格 / 语言习惯 /
 * 背景边界」三个框分区填写（设计稿 full-ui-v1 的「分区填写」模式）。
 * 两头都要顾，办法是给文本定一个小小的固定格式——每个分区前面放一行
 * 【标题】，拼成一段直接读也通顺的正文：
 *
 *   【核心性格】
 *   认真维护自己的幻想小世界……
 *
 *   【语言习惯】
 *   用自然中文，按情境……
 *
 *   【背景边界】
 *   沿用动画版角色……
 *
 * 读的时候按标题拆回三块；T04 时代的旧文本（占位人设）没有标题，
 * 拆不开就原样当成「完整文本」模式展示，不硬猜、不改写用户内容。
 * 这个格式是应用自己的约定：标题独占一行、顺序固定，用户在
 * 「完整文本」模式里随手写的【】字样只要不恰好凑齐三行标准标题，
 * 都不会被误拆。
 */

/** 三个分区的固定标题，顺序即正文里的出现顺序（导出给界面复用） */
export const PERSONA_SECTION_TITLES = ['【核心性格】', '【语言习惯】', '【背景边界】'] as const

/** 分区人设的形状：三个文本块，键名与界面字段一一对应 */
export interface PersonaSections {
  /** 核心性格：她在乎什么、怎样表达关心、遇事怎么反应 */
  core: string
  /** 语言习惯：句长、用词、比喻、称呼方式 */
  speech: string
  /** 背景边界：哪些背景沿用、哪些未知、不能当成共同往事 */
  background: string
}

/** 空的三分区（界面初值用） */
export function emptyPersonaSections(): PersonaSections {
  return { core: '', speech: '', background: '' }
}

/**
 * 三个分区拼接成一段带标题的 personaText。
 * 空分区也保留标题行：这样「拆回」时三标题永远齐全，保存前是分区模式、
 * 重新打开还是分区模式，不会因为某块没填就被当成完整文本。多出的空
 * 标题行对模型无害（T06 组装提示词直接用全文）。
 * 每块内容只去首尾空白、不改动中间；内容里的空行原样保留。
 * @param sections 三个分区文本
 * @returns 可直接存进 character_versions.persona_text 的文本
 */
export function personaFromSections(sections: PersonaSections): string {
  const parts = [
    { title: PERSONA_SECTION_TITLES[0], body: sections.core },
    { title: PERSONA_SECTION_TITLES[1], body: sections.speech },
    { title: PERSONA_SECTION_TITLES[2], body: sections.background },
  ]
  return parts
    .map((part) => `${part.title}\n${part.body.trim()}`)
    // 每段整体再 trim 一次：空分区只剩一行标题，不带尾巴换行，
    // 段与段之间固定一个空行（join 的 '\n\n'），全文格式稳定
    .map((section) => section.trim())
    .join('\n\n')
}

/** 拆分结果：structured=true 表示按分区格式存过；false 表示拆不开 */
export interface ParsedPersona {
  /** 三分区内容；structured=false 时全空，别拿去填表单 */
  sections: PersonaSections
  /** 拆不开时的原文（完整文本模式展示用）；structured=true 时为空串 */
  fullText: string
  /** true=带标准标题的分区格式；false=整段文本（含 T04 旧占位数据） */
  structured: boolean
}

/**
 * 把 personaText 拆回三个分区。
 * 认「标准格式」的标准很严：三行标题各自独占一行（允许行首尾空白）、
 * 恰好三个、顺序正好是核心性格→语言习惯→背景边界。任何不满足
 * （缺标题、多标题、乱序、标题粘着别的字）都按完整文本原样返回。
 * 严是因为这里是「格式的入口」：判断放松一点，用户在完整文本里
 * 随手写的【】就会被误拆，内容看着没丢、分区却对不上号。
 * @param text 数据库里读出的 personaText
 */
export function sectionsFromPersona(text: string): ParsedPersona {
  // 逐行扫出所有「独占一行的标准标题」，记下它们的出现顺序和行号
  const lines = text.split('\n')
  const found: Array<{ titleIndex: number; lineIndex: number }> = []
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim()
    const titleIndex = PERSONA_SECTION_TITLES.indexOf(
      trimmed as (typeof PERSONA_SECTION_TITLES)[number],
    )
    if (titleIndex >= 0) found.push({ titleIndex, lineIndex })
  })

  // 标准 = 恰好三个标题，顺序 0、1、2 递增（不多、不少、不乱、不重复）
  const isStandard =
    found.length === 3 && found.every((item, i) => item.titleIndex === i) &&
    // 第一段标题前若有正文，拆分会把那段丢掉；保留全文才能保住用户原文。
    lines.slice(0, found[0].lineIndex).every((line) => line.trim() === '')

  if (!isStandard) {
    return { sections: emptyPersonaSections(), fullText: text, structured: false }
  }

  // 标题行下一行起到下一个标题行前，是这个分区的内容；收尾去空白
  const slice = (fromLine: number, toLine: number): string =>
    lines.slice(fromLine, toLine).join('\n').trim()
  return {
    sections: {
      core: slice(found[0].lineIndex + 1, found[1].lineIndex),
      speech: slice(found[1].lineIndex + 1, found[2].lineIndex),
      background: slice(found[2].lineIndex + 1, lines.length),
    },
    fullText: '',
    structured: true,
  }
}

/**
 * 三个分区是否全部为空（trim 后）。
 * 服务端保存前用它把关：全空的人设没有内容，存成版本只是制造垃圾行，
 * 按参数不合法拒绝（01 R17 的精神：不假装完成一次无意义的保存）。
 */
export function personaSectionsAllEmpty(sections: PersonaSections): boolean {
  return [sections.core, sections.speech, sections.background].every(
    (part) => part.trim() === '',
  )
}
