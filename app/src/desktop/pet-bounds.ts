/**
 * 桌宠窗口「放回可见区」的纯逻辑：只做数据进、数据出，不碰 Electron——
 * 这样多屏/越界的判断能用固定输入在 Vitest 里自动检查（07 §3），
 * 不必搬真显示器才能验证。
 * 背景：位置保存的是屏幕上的绝对坐标。用户可能拔掉第二台显示器、改系统
 * 缩放，上次的位置在新桌面布局里可能悬在「已经不存在的屏幕」上——
 * 必须拉回看得见的地方（03 §3）。
 */
import type { PetWindowState } from '../shared/window-state'

/** 一块显示器的可用工作区（去掉任务栏后的矩形），字段含义与窗口坐标相同 */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 把保存的位置拉回可见区。
 * 规则：找与窗口重叠面积最大的一块工作区——
 * - 与任何工作区都完全没有重叠（显示器被拔了）→ 返回 null，
 *   由调用方放回默认位置；
 * - 有重叠 → 只做最小平移把窗口完整挪进那块工作区，不改尺寸
 *   （大小是用户亲手调的，不该被悄悄动）；
 * - 窗口某一维比工作区还大（极端放大）→ 那一维贴工作区的左/上边，
 *   保证至少看得见一部分。
 * @param saved 上次保存的位置与尺寸
 * @param areas 当前所有显示器的工作区
 * @returns 拉回后的位置；完全不可见时返回 null
 */
export function clampPetBounds(saved: PetWindowState, areas: WorkArea[]): PetWindowState | null {
  let best: WorkArea | undefined
  let bestOverlap = 0
  for (const area of areas) {
    // 两个矩形的重叠宽 × 重叠高 = 重叠面积。先算水平方向公共部分的宽：
    // 右边取两者较靠左的右边界，左边取两者较靠右的左边界，左边不小于右边才有公共部分
    const overlapX =
      Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)
    const overlapY =
      Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y)
    const overlap = Math.max(0, overlapX) * Math.max(0, overlapY)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = area
    }
  }
  if (!best) return null
  // 允许 x 落在 [工作区左界, 工作区左界 + (工作区宽 - 窗口宽)] 之间；
  // 窗口比工作区宽时上限就是左界本身（即对齐左上角），所以先 Math.max(0, …)
  const maxX = best.x + Math.max(0, best.width - saved.width)
  const maxY = best.y + Math.max(0, best.height - saved.height)
  return {
    ...saved,
    x: Math.min(Math.max(saved.x, best.x), maxX),
    y: Math.min(Math.max(saved.y, best.y), maxY),
  }
}

/**
 * 默认位置：指定工作区的中央、原始尺寸。
 * 右键菜单「恢复默认」和「保存的位置完全不可见时的落点」共用这一份，
 * 免得两处各算各的、哪天改了一处忘了另一处。
 */
export function defaultPetBounds(
  naturalWidth: number,
  naturalHeight: number,
  area: WorkArea,
): PetWindowState {
  return {
    x: area.x + Math.round((area.width - naturalWidth) / 2),
    y: area.y + Math.round((area.height - naturalHeight) / 2),
    width: naturalWidth,
    height: naturalHeight,
  }
}
