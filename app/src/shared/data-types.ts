/**
 * 界面与后台共用的「角色概览」数据形状（T05）。
 * 定义放 shared 的原因与 DialogueExample 相同（见 character-schema.ts）：
 * data 层产出它、界面消费它，谁都不该「拥有」谁——
 * 尤其界面（纯网页）不能顺着类型引子把 data 层的数据库代码拉进打包。
 * 这里只有类型（type），编译后整个文件不剩一行运行时代码。
 */
import type { DialogueExample } from './character-schema'

/** 一条人设版本在列表里的样子（界面版本列表用；不含人设正文，省流量） */
export interface CharacterVersionSummary {
  versionNo: number
  /** 是否当前生效 */
  isActive: boolean
  /** 创建时间（UTC 毫秒数字） */
  createdAt: number
}

/** 当前生效版本的完整内容（界面打开编辑页时填表单用） */
export interface ActiveVersionContent {
  versionNo: number
  personaText: string
  initialRelationship: string
  /** null = 未设定称呼 */
  userNickname: string | null
  dialogueExamples: DialogueExample[]
}

/** 角色概览：GET /character 一口气要发的全部内容 */
export interface CharacterOverview {
  characterId: string
  name: string
  /** 桌面形象图片相对路径；null = 未设置（显示占位图） */
  desktopImagePath: string | null
  /** 聊天立绘相对路径；null = 未设置 */
  portraitImagePath: string | null
  /** 当前生效版本（角色初始化保证存在；万一被外力删掉则此处为 null，
   *  界面按空表单处理，保存时自然会建出第 2 版） */
  activeVersion: ActiveVersionContent | null
  /** 全部版本，新版本在前 */
  versions: CharacterVersionSummary[]
}

/** 保存一版人设的结果（POST /character/version 的回包数据） */
export interface SaveVersionResult {
  /** 保存后的版本号 */
  versionNo: number
  /** true=本次新建；false=同一请求编号重复到达，返回已存版本 */
  created: boolean
}
