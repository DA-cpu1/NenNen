/**
 * 后台进程里的"总机"：接本机打来的 HTTP 电话。三道保险——
 * ① 只绑 127.0.0.1（回环地址：这根线只有本机能拨，外面的网络进不来）；
 * ② 端口随机（写死端口可能撞上被别的软件占用的号，导致起不来）；
 * ③ 对暗号（本机上任何进程都能往本地打电话，没有暗号它们就能偷读聊天记录）。
 * 暗号由调用方交进来（子进程入口从管子收到后传入，测试直接传固定值），
 * 这里只负责核对，不负责生成。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** 总机句柄：端口号 + 关机方法 */
export interface BackendServer {
  /** 系统随机分到的端口号 */
  port: number
  /** 关机：不再接新电话，等正在通话的结束，然后关掉 */
  stop(): Promise<void>
}

/**
 * 核对来电暗号。
 * 为什么不用普通的 ===？=== 比字符串，错在第一位就提前结束、错在最后一位
 * 才结束——隔壁进程掐着秒表就能一位一位试出暗号。timingSafeEqual 让对错
 * 耗时完全一样，掐表无意义。
 * @param req 进来的请求
 * @param token 本次开机的暗号
 * @returns 是否对上
 */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  // 暗号放请求头而不是网址后面——网址会被各种日志原样记下来，请求头不会
  const provided = req.headers['x-session-token']
  if (typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 统一按 JSON 格式回话，免得每个分支各写一套 */
function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 启动总机。
 * @param token 本次开机的暗号
 * @returns 返回的是一张"取货凭证"（Promise）：此刻还没监听成功，将来兑现成
 *          端口号和关机方法。端口是系统分配的，只有监听成功"回电"那一刻才
 *          知道是几号——所以发货(resolve)必须写在回电(回调)里
 */
export function startBackendServer(token: string): Promise<BackendServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // 暗号不对：不说"差一点就对了"（那是在帮试探者缩小范围），统一拒接
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' })
        return
      }
      // 最小健康检查：主进程开机后拿它自测通道。聊天、记忆这些正式入口
      // 以后按白名单逐个加
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' })
    })

    server.on('error', reject)
    // 端口 0 = "系统你挑个空闲的"；只绑本机回环地址，外面的网络进不来
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      // 走到这里 address() 必然是对象；这个判断只是让编译器放心，实际不会发生
      if (!addr || typeof addr === 'string') {
        reject(new Error('未能获取后台服务监听端口'))
        return
      }
      resolve({
        port: addr.port,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
