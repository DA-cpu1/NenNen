/**
 * 把「应用管理的图片相对路径」变成界面 <img> 能用的地址（T05）。
 * 数据库里只存 characters/<角色ID>/desktop.png 这种相对路径；界面显示时
 * 经 app-asset:// 协议（desktop/app-asset.ts）翻译成本地文件。
 * 协议名常量定义在这里、主进程那边来引：shared 是两边的公共层，
 * 反过来引（shared → desktop）会把 electron 打进界面构建里，直接炸构建。
 *
 * 拼在末尾的 ?v=时间戳 是「破缓存」用的：换图后文件名不变（固定名覆盖），
 * 浏览器会认为「同一个地址，图没变」继续显示旧图；地址里带个每次都不同
 * 的小尾巴，它才会当新图重新加载。T05⑩ 换图后界面会用新时间戳刷新。
 */

/** 应用自己的图片协议名；desktop/app-asset.ts 注册、这里拼 URL */
export const APP_ASSET_SCHEME = 'app-asset'

/** 相对路径 → app-asset URL。路径为空（没设图片）时返回 null */
export function assetUrl(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null
  return `${APP_ASSET_SCHEME}://app/${relativePath}?v=${Date.now()}`
}
