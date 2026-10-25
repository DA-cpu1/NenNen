/**
 * 角色编辑相关的共享数据形状（T05）：对话示例的条目结构，以及
 * 「保存人设版本 / 回退版本 / 更新图片」三条通道的请求格式关卡。
 * 放在 shared 是因为多处都要用同一份定义——
 * data 层存取（character-edit.ts）、服务端点校验（server.ts 的 Zod）、
 * 界面表单（角色设置页）。三处各写一份迟早对不上账。
 */
import { z } from 'zod'

/** 一条情境对话示例（02 §1「情境示例」）：一个场景标签 + 用户与角色的各一句话 */
export interface DialogueExample {
  /** 场景标签，如「分享开心的事」；界面编辑用，提示词组装也会带上 */
  scene: string
  /** 用户那句话 */
  user: string
  /** 角色回应的那句话 */
  character: string
}

/** 单条示例的格式关卡：三个字符串必到、用户与角色的话不能是空白 */
export const dialogueExampleSchema = z.strictObject({
  scene: z.string(),
  user: z.string().refine((value) => value.trim() !== '', { message: '示例的用户句不能为空' }),
  character: z.string().refine((value) => value.trim() !== '', { message: '示例的角色句不能为空' }),
})

/** 保存人设版本的请求体（POST /character/version） */
export const saveCharacterVersionSchema = z.strictObject({
  /** 界面本次点「保存」生成的请求编号：重试沿用同一个，服务端靠它防重 */
  requestId: z.string().refine((value) => value.trim() !== '', { message: 'requestId 不能为空' }),
  /** 角色名字（改到 characters 表；不许存空白名） */
  name: z.string().refine((value) => value.trim() !== '', { message: '名字不能为空' }),
  /** 分区人设：分区填写模式带这个字段，服务端负责拼成 personaText */
  personaSections: z
    .strictObject({ core: z.string(), speech: z.string(), background: z.string() })
    .optional(),
  /** 完整文本模式带这个字段（与 personaSections 二选一） */
  personaFullText: z.string().optional(),
  /** 初始关系设定 */
  initialRelationship: z
    .string()
    .refine((value) => value.trim() !== '', { message: '初始关系不能为空' }),
  /** 称呼设定；空字符串按「未设定」归一成 null 再入库 */
  userNickname: z.string().nullable(),
  /** 情境对话示例；给个上限防异常请求塞爆请求体 */
  dialogueExamples: z.array(dialogueExampleSchema).max(20),
})

/** 保存请求体解析后的类型 */
export type SaveCharacterVersionBody = z.infer<typeof saveCharacterVersionSchema>

/** 回退版本的请求体（POST /character/version/activate） */
export const activateCharacterVersionSchema = z.strictObject({
  versionNo: z.number().int().positive(),
})

/**
 * 图片路径的格式关卡（PUT /character/images）：只认应用自己管理的
 * characters/ 开头相对路径，不许绝对路径、不许「..」回头路——
 * 这条规则防的事故：万一哪天有人把界面传来的路径直接拿去读文件，
 * 越不过 userData/characters 这个院子（路径穿越）。
 */
export const managedImagePathSchema = z
  .string()
  .refine((value) => value.startsWith('characters/'), { message: '只接受 characters/ 开头的相对路径' })
  .refine((value) => !value.includes('..'), { message: '路径不许包含 ..' })
  .refine((value) => /^characters\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.png$/.test(value), { message: '只接受角色目录中的 PNG 文件名' })

/** 更新图片的请求体（PUT /character/images）：null=清除，缺省=不动 */
export const updateCharacterImagesSchema = z.strictObject({
  desktopImagePath: managedImagePathSchema.nullable().optional(),
  portraitImagePath: managedImagePathSchema.nullable().optional(),
})
