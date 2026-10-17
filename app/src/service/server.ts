/**
 * 后台服务 HTTP 服务器（03 §3 后台部分的最小实现）：
 * 只监听 127.0.0.1 的随机可用端口，每个请求必须携带本次启动生成的会话令牌，
 * 未认证请求一律返回 401，不向局域网开放。
 * 令牌由调用方（子进程入口 src/service/index.ts 或测试）通过受控通道提供；
 * 本模块只负责校验，不负责生成，避免令牌来源混乱。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** 后台服务句柄：暴露实际端口与关闭方法 */
export interface BackendServer {
  /** 系统随机分配的实际监听端口 */
  port: number
  /** 优雅关闭：停止接收新连接，等待现有连接结束后返回 */
  stop(): Promise<void>
}

/**
 * 校验请求令牌是否与本次启动的令牌一致。
 * 用恒定时间比较防止本地进程通过响应快慢猜测令牌。
 * @param req 进入的 HTTP 请求
 * @param token 本次启动生成的会话令牌
 * @returns 是否认证通过
 */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  // 令牌放在自定义请求头而不是查询参数，避免随 URL 进入各类日志（03 §7）
  const provided = req.headers['x-session-token']
  if (typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 统一输出 JSON 响应，避免各端点各写一套 */
function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 启动后台服务：绑定 127.0.0.1 的随机端口（端口传 0 由系统分配）。
 * @param token 本次启动的会话令牌（经 stdin 等受控通道送达，见 03 §3）
 * @returns 端口与关闭方法；端口冲突等启动失败会 reject
 */
export function startBackendServer(token: string): Promise<BackendServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // 认证不通过：不区分「没带令牌」和「令牌错误」，统一 401
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' })
        return
      }
      // 最小健康检查端点；聊天、记忆、工具入口在后续步骤按 bridge 白名单加入
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' })
    })

    server.on('error', reject)
    // 端口 0 = 系统分配随机可用端口；只绑回环地址
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      // TCP 监听的 address() 一定是对象；此分支只做类型收窄兜底
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
