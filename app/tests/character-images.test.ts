/** 换图故障检查：假系统选框、临时目录和服务回包，不碰用户原图。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
const fake = vi.hoisted(() => ({ dataDir: '', handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), choose: vi.fn(), empty: false }))
vi.mock('electron', () => ({
  app: { getPath: () => fake.dataDir }, dialog: { showOpenDialog: fake.choose },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(name, handler) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => fake.empty, getSize: () => ({ width: 200, height: 400 }), toPNG: () => Buffer.from('new-png') }) },
}))
import { registerCharacterImagePicking, type PickImageResult } from '../src/desktop/character-images'
const saved = vi.fn((_slot: string, _width: number, _height: number) => {})
const oldPath = 'characters/char-fixed/desktop.png'
let mode: 'ok' | 'reject' | 'lost' = 'ok'
let currentPath = oldPath
let writes = 0
beforeEach(() => {
  fake.dataDir = mkdtempSync(join(tmpdir(), 'companion-image-test-'))
  mkdirSync(join(fake.dataDir, 'characters/char-fixed'), { recursive: true })
  writeFileSync(join(fake.dataDir, oldPath), 'old-png')
  currentPath = oldPath; mode = 'ok'; writes = 0; fake.empty = false
  fake.choose.mockReset().mockResolvedValue({ canceled: false, filePaths: ['fixture.png'] })
  saved.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options?.method === 'PUT') {
      writes += 1
      if (mode === 'reject') return Response.json({ ok: false }, { status: 500 })
      currentPath = JSON.parse(options.body).desktopImagePath
      if (mode === 'lost') throw Error('LOST_REPLY')
      return Response.json({ ok: true })
    }
    return Response.json({ ok: true, character: { characterId: 'char-fixed', desktopImagePath: currentPath } })
  }))
  registerCharacterImagePicking(() => ({ port: 1, token: 'fixed-test-token', stop() {} }), saved)
})
afterEach(() => {
  vi.unstubAllGlobals()
  // 只清理由本测试创建、且位于系统临时目录的文件夹。
  if (resolve(fake.dataDir).startsWith(resolve(tmpdir()) + sep) && basename(fake.dataDir).startsWith('companion-image-test-')) rmSync(fake.dataDir, { recursive: true })
})
/** 模拟 preload 调用固定图片通道；不模拟后台的成功结果判断。 */
async function pick(slot: unknown = 'desktop'): Promise<PickImageResult> {
  return await fake.handlers.get('character:pick-image')!({}, slot) as PickImageResult
}
describe('换图失败保住原图', () => {
  it('库拒绝写入时原图不变，也不发成功通知', async () => {
    mode = 'reject'
    expect((await pick()).ok).toBe(false)
    expect(currentPath).toBe(oldPath)
    expect(readFileSync(join(fake.dataDir, oldPath), 'utf8')).toBe('old-png')
    expect(saved).not.toHaveBeenCalled()
  })
  it('写库成功但回包丢失时读回确认，写请求只有一次', async () => {
    mode = 'lost'
    const result = await pick()
    expect(result.ok).toBe(true)
    expect(result.relativePath).toBe(currentPath)
    expect(writes).toBe(1)
    expect(readFileSync(join(fake.dataDir, oldPath), 'utf8')).toBe('old-png')
    expect(saved).toHaveBeenCalledWith('desktop', 200, 400)
  })
  it('取消和坏图不写库，也不新增图片文件', async () => {
    fake.choose.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect((await pick()).code).toBe('CANCELLED')
    fake.empty = true
    expect((await pick()).code).toBe('INVALID_IMAGE')
    expect(writes).toBe(0)
    expect(readdirSync(join(fake.dataDir, 'characters/char-fixed'))).toEqual(['desktop.png'])
  })
  it('选框异常或非法槽位返回错误，通道不直接抛异常', async () => {
    fake.choose.mockRejectedValueOnce(Error('DIALOG_FAILURE'))
    expect((await pick()).code).toBe('IMAGE_SAVE_FAILED')
    expect((await pick('unknown')).code).toBe('INVALID_INPUT')
    expect(writes).toBe(0)
  })
})
