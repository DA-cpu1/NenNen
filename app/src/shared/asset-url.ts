/**
 * 把「应用管理的图片相对路径」变成界面 <img> 能用的地址（T05）。
 * 数据库里只存 characters/<角色ID>/desktop-<文件编号>.png 这种相对路径；界面显示时
 * 经 app-asset:// 协议（desktop/app-asset.ts）翻译成本地文件。
 * 协议名常量定义在这里、主进程那边来引：shared 是两边的公共层，
 * 反过来引（shared → desktop）会把 electron 打进界面构建里，直接炸构建。
 *
 * 新图使用新文件名，地址自然不同。普通重新渲染不会反复生成新地址，
 * 避免用户每打一个字，浏览器就把同一张图重新读一遍。
 */

/** 应用自己的图片协议名；desktop/app-asset.ts 注册、这里拼 URL */
export const APP_ASSET_SCHEME = 'app-asset'

/** 相对路径 → app-asset URL。路径为空（没设图片）时返回 null */
export function assetUrl(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null
  return `${APP_ASSET_SCHEME}://app/${relativePath}`
}
