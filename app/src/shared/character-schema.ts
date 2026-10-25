/**
 * 角色编辑相关的共享数据形状（T05）：对话示例的条目结构。
 * 放在 shared 是因为三处都要用同一份定义——
 * data 层存取（character-edit.ts）、服务端点校验（server.ts 的 Zod）、
 * 界面表单（角色设置页）。三处各写一份迟早对不上账。
 */

/** 一条情境对话示例（02 §1「情境示例」）：一个场景标签 + 用户与角色的各一句话 */
export interface DialogueExample {
  /** 场景标签，如「分享开心的事」；界面编辑用，提示词组装也会带上 */
  scene: string
  /** 用户那句话 */
  user: string
  /** 角色回应的那句话 */
  character: string
}
