/**
 * 「更换图片」的主进程半边（T05 图片设置）。
 * 文件选择框和文件复制只有主进程能做——界面进程是被沙箱包住的纯网页，
 * 碰不了磁盘（03 §7）。流程四步：
 * 问后台要角色 ID → 弹系统选图框 → 把用户选的 PNG 复制进应用数据目录
 * → 把「图片在哪」记进数据库。新图片用新文件名，写库失败不会盖掉旧图。
 *
 * 为什么复制而不是记住用户的原路径：原文件住在用户自己的文件夹里，
 * 用户哪天移动/删除它，应用里的角色就跟着缺图；复制进 userData 后，
 * 图片跟数据库一样归应用管，卸载清理的范围也因此明确（05 §6）。
 */
import { app, dialog, ipcMain, nativeImage } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BackendHandle } from './backend'

/** 两张图各一个槽位：桌面 Q 版形象 / 聊天窗口立绘 */
export type ImageSlot = 'desktop' | 'portrait'

/** 换图结果：成功带应用管理的相对路径与图片尺寸；失败只带错误码 */
export interface PickImageResult {
  ok: boolean
  /** 应用管理的相对路径（带独立文件编号），成功时才有 */
  relativePath?: string
  /** 图片像素尺寸；桌面形象换图后主进程要用它调整桌宠窗口 */
  width?: number
  height?: number
  code?: string
}

/**
 * 注册换图通道。图片不只是「路径入库」——复制文件、读尺寸这些主进程
 * 专属能力都在这里做，preload 只透传「desktop / portrait」这个槽位名。
 * @param getBackend 取当前后台句柄（记路径要走后台写库，05 §1 单点写入）
 * @param onSaved 图片确实保存后刷新窗口的回调
 */
export function registerCharacterImagePicking(
  getBackend: () => BackendHandle | undefined,
  onSaved: (slot: ImageSlot, width: number, height: number) => void,
): void {
  let picking = false
  ipcMain.handle('character:pick-image', async (_event, slot: unknown): Promise<PickImageResult> => {
    if (slot !== 'desktop' && slot !== 'portrait') return { ok: false, code: 'INVALID_INPUT' }
    if (picking) return { ok: false, code: 'IMAGE_BUSY' }
    picking = true
    try {
      const result = await pickImage(getBackend(), slot)
      if (result.ok) {
        try { onSaved(slot, result.width!, result.height!) }
        catch { console.error('[图片] E_WINDOW_REFRESH') }
      }
      return result
    } catch { return { ok: false, code: 'IMAGE_SAVE_FAILED' } }
    finally { picking = false }
  })
}

/** 一次换图的全流程；各步失败都带着明确的错误码返回，不抛到通道外 */
async function pickImage(handle: BackendHandle | undefined, slot: ImageSlot): Promise<PickImageResult> {
  if (!handle) return { ok: false, code: 'BACKEND_NOT_READY' }

  // ① 角色 ID 问后台要：主进程不碰数据库（05 §1），而图片目录按角色分
  //    （A07 的多角色隔离从文件层就开始，不等到数据库才分家）
  let characterId: string
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/character`, {
      headers: { 'x-session-token': handle.token },
    })
    const body = (await res.json()) as { ok: boolean; character?: { characterId?: string } | null }
    if (!res.ok || !body.ok || !body.character?.characterId) {
      return { ok: false, code: 'NO_CHARACTER' }
    }
    characterId = body.character.characterId
    if (!/^[a-zA-Z0-9_-]+$/.test(characterId)) return { ok: false, code: 'INVALID_CHARACTER' }
  } catch {
    return { ok: false, code: 'BACKEND_UNREACHABLE' }
  }

  // ② 系统选图框。只收 PNG：桌宠和立绘都要透明背景，JPEG 存不了透明
  //    （它有损压缩、没有 alpha 通道），放开格式只会换来「换完图四方块」
  const picked = await dialog.showOpenDialog({
    title: slot === 'desktop' ? '选择桌面形象图片（PNG）' : '选择聊天立绘图片（PNG）',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    properties: ['openFile'],
  })
  if (picked.canceled || picked.filePaths.length === 0) {
    return { ok: false, code: 'CANCELLED' }
  }
  const sourcePath = picked.filePaths[0]

  // ③ 先写一份独立新文件，再让数据库切换路径。不能先覆盖旧图：
  //    否则库写失败时虽然返回失败，用户的原图却已经被替换。
  const image = nativeImage.createFromPath(sourcePath)
  if (image.isEmpty()) {
    // 读不出内容：文件坏了或不是真 PNG。当场告诉用户，不入库不复制
    return { ok: false, code: 'INVALID_IMAGE' }
  }
  const { width, height } = image.getSize()
  const targetDir = join(app.getPath('userData'), 'characters', characterId)
  const fileName = `${slot}-${randomUUID()}.png`
  try {
    mkdirSync(targetDir, { recursive: true })
    // 重新编码为 PNG：即使用户绕过选框过滤选了其他可读格式，实际保存仍是 PNG。
    writeFileSync(join(targetDir, fileName), image.toPNG(), { flag: 'wx' })
  } catch {
    return { ok: false, code: 'COPY_FAILED' }
  }
  const relativePath = `characters/${characterId}/${fileName}`

  // ④ 路径记进数据库（经后台写库通道，值本身就是后台校验规则认的形状）
  const field = slot === 'desktop' ? 'desktopImagePath' : 'portraitImagePath'
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/character/images`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': handle.token },
      body: JSON.stringify({ [field]: relativePath }),
    })
    const body = (await res.json()) as { ok: boolean }
    if (res.ok && body.ok) return { ok: true, relativePath, width, height }
  } catch {
    // 回包丢失也可能已写成功，下面读回路径再确认；不重发写操作。
  }
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/character`, { headers: { 'x-session-token': handle.token } })
    const body = await res.json() as { ok: boolean; character?: Record<string, unknown> }
    if (res.ok && body.ok && body.character?.[field] === relativePath) return { ok: true, relativePath, width, height }
  } catch { /* 无法确认时保留新旧文件；绝不能删掉数据库可能已经引用的新图片。 */ }
  return { ok: false, code: 'IMAGE_SAVE_UNCONFIRMED' }
}
