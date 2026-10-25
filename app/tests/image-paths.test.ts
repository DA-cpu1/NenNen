/** 图片路径与默认比例检查，防止换图越界读取或把宽图拉成长条。 */
import { describe, expect, it } from 'vitest'
import { managedImagePathSchema } from '../src/shared/character-schema'
import { assetUrl } from '../src/shared/asset-url'
import { petImageSize } from '../src/desktop/pet-bounds'
describe('图片访问与窗口比例', () => {
  it('旧路径和独立新文件名都可读，反斜杠和越界路径不可读', () => {
    for (const path of ['characters/char-x/desktop.png', 'characters/char-x/desktop-a-b.png']) expect(managedImagePathSchema.safeParse(path).success).toBe(true)
    for (const path of ['characters/x/../key.png', 'characters/x/C:\\key.png', 'characters/x/%2e%2e.png', '/other.png']) expect(managedImagePathSchema.safeParse(path).success).toBe(false)
  })
  it('普通重新渲染用相同图片地址，新路径产生新地址', () => {
    expect(assetUrl('characters/x/desktop.png')).toBe(assetUrl('characters/x/desktop.png'))
    expect(assetUrl('characters/x/desktop-a.png')).not.toBe(assetUrl('characters/x/desktop.png'))
  })
  it('竖图、宽图和无效尺寸都落入合理默认大小', () => {
    expect(petImageSize(400, 800)).toEqual({ width: 130, height: 260 })
    expect(petImageSize(1600, 400)).toEqual({ width: 360, height: 90 })
    expect(petImageSize(0, 0)).toEqual({ width: 200, height: 260 })
  })
})
