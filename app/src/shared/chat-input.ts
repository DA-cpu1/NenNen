/**
 * 在界面和后台共用单条输入限制，防止绕过输入框后把超长文字存进聊天。
 * JavaScript 的 length 会把部分 emoji 算成两个；这里逐个 Unicode 码点计数。
 * 码点就是 Unicode 给文字或符号分配的编号，组合 emoji 仍可能包含多个码点。
 */
export const MAX_CHAT_INPUT_CHARACTERS = 8_000

/**
 * 拒绝空白或超长正文，不删空格、不改写用户原话。
 * @param content 用户输入的完整正文
 * @returns 通过时无返回值；失败抛 E_INVALID_MESSAGE 或 E_MESSAGE_TOO_LONG
 */
export function assertChatInput(content: string): void {
  if (!content.trim()) throw new Error('E_INVALID_MESSAGE')
  let characters = 0
  for (const _character of content) {
    characters += 1
    if (characters > MAX_CHAT_INPUT_CHARACTERS) throw new Error('E_MESSAGE_TOO_LONG')
  }
}
