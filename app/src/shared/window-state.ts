/**
 * 桌宠窗口位置的「公共数据格式」：主进程（保存/恢复）和后台服务（存库/读库）
 * 两个构建包都要认得这份数据长什么样，所以放在 shared 层（03 §4）。
 * 用 Zod 描述格式：同一份描述既当「类型」（编译期查字段名打错），
 * 又当「关卡」（运行期拦住缺字段、错类型的脏数据，03 §2）。
 */
import { z } from 'zod'

/** 窗口位置存在 app_settings 表里用的键名（05 §2） */
export const PET_WINDOW_KEY = 'petWindow'

/**
 * 桌宠窗口的矩形位置与尺寸。坐标单位是系统的逻辑像素（DIP：Windows 在
 * 高分屏上会把像素放大，比如 150% 缩放时一个 DIP = 1.5 个物理像素；
 * Electron 的窗口坐标统一用 DIP，这里入乡随俗）。
 * strictObject：多出来的字段一律不认——自己人传错数据立刻暴露，
 * 好过悄悄存进库再在别处炸。
 */
export const petWindowStateSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

/** 从上面的 Zod 描述自动推出的 TypeScript 类型：四个整数字段 */
export type PetWindowState = z.infer<typeof petWindowStateSchema>
