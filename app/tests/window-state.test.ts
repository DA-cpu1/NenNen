/**
 * 「放回可见区」纯逻辑的自动检查（07 §3：固定输入，不依赖真实显示器）。
 * 每个用例对应一个真实事故场景：
 * 半个身子跑出屏幕、保存的位置在被拔掉的显示器上、窗口放大到比屏还宽……
 */
import { describe, expect, it } from 'vitest'
import { clampPetBounds, defaultPetBounds } from '../src/desktop/pet-bounds'
import type { PetWindowState } from '../src/shared/window-state'

/** 造一个保存值：默认 100,100 处的 200×260，测试只改关心的字段 */
const saved = (over: Partial<PetWindowState> = {}): PetWindowState => ({
  x: 100,
  y: 100,
  width: 200,
  height: 260,
  ...over,
})

/** 单屏 1920×1080 去掉任务栏后的典型工作区 */
const DESK = { x: 0, y: 0, width: 1920, height: 1040 }

describe('clampPetBounds 放回可见区', () => {
  it('位置完全在工作区内：原样返回，不做任何移动', () => {
    const state = saved()
    expect(clampPetBounds(state, [DESK])).toEqual(state)
  })

  it('右半边跑出屏幕：只水平拉回到右边缘内，y 不动', () => {
    const result = clampPetBounds(saved({ x: 1800 }), [DESK])
    expect(result).toEqual(saved({ x: 1720 }))
  })

  it('保存位置在被拔掉的显示器上（与所有工作区无重叠）：返回 null', () => {
    expect(clampPetBounds(saved({ x: -3000, y: 5000 }), [DESK])).toBeNull()
  })

  it('窗口放大到比工作区还宽：水平贴左边缘，纵向仍在界内的 y 不动', () => {
    const result = clampPetBounds(saved({ x: 500, y: 300, width: 2000 }), [DESK])
    expect(result).toEqual(saved({ x: 0, y: 300, width: 2000 }))
  })

  it('双屏：左半边压着两屏交界，与右屏重叠更多就整体进右屏', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1040 }
    // 窗口 x=1850：与左屏重叠 70、与右屏重叠 130 → 应进右屏，x 拉到 1920
    const result = clampPetBounds(saved({ x: 1850 }), [DESK, second])
    expect(result).toEqual(saved({ x: 1920 }))
  })

  it('工作区列表为空（极端：系统报不出显示器）：返回 null 走默认', () => {
    expect(clampPetBounds(saved(), [])).toBeNull()
  })
})

describe('defaultPetBounds 默认位置', () => {
  it('放在工作区中央，尺寸用原始值，坐标四舍五入成整数', () => {
    expect(defaultPetBounds(200, 260, DESK)).toEqual({
      x: 860,
      y: 390,
      width: 200,
      height: 260,
    })
  })
})
