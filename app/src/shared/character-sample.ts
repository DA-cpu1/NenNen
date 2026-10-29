/**
 * 把已确认的角色样稿随应用打包，供新库初始化和编辑页主动载入。
 * ?raw 让构建工具把 Markdown 当文字放进产物，不在用户电脑上另找开发文件。
 */
import commonRulesSource from '../../characters/common-rules.md?raw'
import personaSource from '../../characters/rikka/persona.md?raw'
import examplesSource from '../../characters/rikka/examples.md?raw'
import type { DialogueExample } from './character-schema'

/** 去掉作者给开发者看的文件职责注释，模型只收到规则和角色内容。 */
function withoutComment(source: string): string {
  return source.replace(/^<!--[^]*?-->\s*/, '').trim()
}

/**
 * 每个场景的连续问答保持原次序；示例独立于真实历史，不冒充用户说过的话。
 * @returns 已确认样稿的十三对问答；源文件格式坏了则明确报错
 */
function readExamples(): DialogueExample[] {
  const examples: DialogueExample[] = []
  for (const block of examplesSource.split(/^## /m).slice(1)) {
    const scene = block.split('\n')[0].replace(/^\d+\.\s*/, '').trim()
    for (const pair of block.matchAll(/用户：「([^]*?)」\s*六花：「([^]*?)」/g)) {
      examples.push({ scene, user: pair[1], character: pair[2] })
    }
  }
  if (examples.length !== 13) throw new Error('E_INVALID_CHARACTER_SAMPLE')
  return examples
}

/** 共同规则由应用内部提供，用户草稿不能删除这层事实和工具结果边界。 */
export const COMMON_FACT_RULES = withoutComment(commonRulesSource)

/** 样稿只用于明确初始化/载入，不在启动时覆盖已有数据库。 */
export const RIKKA_SAMPLE = {
  personaText: withoutComment(personaSource),
  initialRelationship: '恋人',
  dialogueExamples: readExamples(),
}
