/**
 * app-asset:// 自定义协议（T05 图片显示）。
 * 为什么需要它：界面是普通网页，浏览器安全规矩「网页只能加载自己源里的
 * 资源」；角色图片是磁盘上的本地文件（file:// 路径），直接往 <img src>
 * 里塞，开发模式（页面跑在开发服务器上）会被当成跨域拦下。注册一个
 * 应用自己的协议名，把 app-asset://… 翻译成「读 userData 下的某个文件」，
 * 页面加载图片就与加载普通网络图无异。
 *
 * 安全边界：协议只放行 characters/ 开头、不含「..」的相对路径——
 * 界面无论传什么，最终能读到的文件都出不了 userData/characters 这个
 * 院子（路径穿越被挡在门口，与后台 PUT /character/images 的校验同一条线）。
 */
import { app, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_ASSET_SCHEME } from '../shared/asset-url'

/**
 * 声明「这是一个标准协议」。必须在 app 就绪（whenReady）之前调用，
 * Electron 只在这时收表——之后注册处理函数（registerAppAssetProtocol）。
 * standard: true 让它支持 app-asset://主机/路径 的标准 URL 解析；
 * secure: true 让页面把它当安全来源，不触发混合内容告警。
 */
export function registerAppAssetSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_ASSET_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ])
}

/**
 * 挂上协议的「翻译员」：把进来的 app-asset:// 请求翻成本地文件读取。
 * 在 app.whenReady() 之后调用。net.fetch(file://…) 会把文件内容包装成
 * 标准的 Response（协议处理器要求的返回形状），大文件自动走流式。
 */
export function registerAppAssetProtocol(): void {
  protocol.handle(APP_ASSET_SCHEME, (request) => {
    const url = new URL(request.url)
    // 只认 app-asset://app/… 这一种写法；主机名乱写一律拒
    if (url.hostname !== 'app') {
      return new Response(null, { status: 403 })
    }
    // pathname 形如 /characters/char-x/desktop.png；中文或空格会被编码，
    // 先解码回原样再拼路径
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '')
    if (!relative.startsWith('characters/') || relative.includes('..')) {
      return new Response(null, { status: 403 })
    }
    const absolute = join(app.getPath('userData'), relative)
    // net.fetch 失败（文件不存在等）自己会返回 4xx/5xx 的 Response，不炸进程
    return net.fetch(pathToFileURL(absolute).toString())
  })
}
