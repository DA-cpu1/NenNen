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
import { callModelOnce, type ModelCallResult } from '../agent/model'

/** 总机句柄：端口号 + 关机方法 */
export interface BackendServer {
  /** 系统随机分到的端口号 */
  port: number
  /** 关机：不再接新电话，等正在通话的结束，然后关掉 */
  stop(): Promise<void>
}

/** 启动选项：模型密钥 + 可替换的模型调用函数（测试塞假的，不真花钱） */
export interface BackendOptions {
  /** 模型密钥；没有就只起基础服务，/model/ping 返回 NO_KEY */
  modelApiKey?: string
  /** 模型调用函数；默认用真的。测试注入假实现，避免真的调付费接口 */
  callModel?: typeof callModelOnce
  /** eve 自测函数由后台入口提供；没启动 eve 时不开放这条能力。 */
  pingAgent?: (signal: AbortSignal) => Promise<ModelCallResult>
  /** 运行期换密钥：由入口实现（整体替换 eve 进程）；测试注入假函数。 */
  rotateModelKey?: (newKey: string) => Promise<void>
  /** 数据库自测读写：由后台入口提供（打开的真库）；测试注入假函数。
   *  为什么做成注入函数而不是直接 import 数据库代码：总机这层只管
   *  「接电话、对暗号、按规则回话」，库文件从哪来、怎么开是入口的事；
   *  测试也因此能用假读写函数，不碰真实文件（07 §3 固定输入）。 */
  db?: {
    /** 读 app_state 表的共享记忆版本号（当前唯一的业务值） */
    readEpoch(): number
    /** 共享记忆版本号 +1 并返回新值——一次真实的业务写 */
    bumpEpoch(): number
  }
}

/** 请求体的体积上限：合法的换密钥请求只有几十字节，超大的一律当恶意丢弃 */
const MAX_BODY_BYTES = 16_384

/**
 * 把 POST 请求体读完并按 JSON 解析。
 * 请求体和管道一样是「流」——分批到达，必须攒齐再解析；
 * 超过体积上限直接抛错，调用方统一按 INVALID_INPUT 回绝。
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('E_BODY_TOO_LARGE')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
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
 * @param options 模型密钥与可替换的调用函数（测试用）
 * @returns 返回的是一张"取货凭证"（Promise）：此刻还没监听成功，将来兑现成
 *          端口号和关机方法。端口是系统分配的，只有监听成功"回电"那一刻才
 *          知道是几号——所以发货(resolve)必须写在回电(回调)里
 */
export function startBackendServer(
  token: string,
  options: BackendOptions = {},
): Promise<BackendServer> {
  return new Promise((resolve, reject) => {
    // 回调用了 async（/model/ping 要等模型回话），所以整体包 try/catch，
    // 不让任何意外把整个进程带崩
    const server = createServer((req, res) => {
      void handleRequest(req, res, token, options).catch(() => {
        sendJson(res, 500, { ok: false, code: 'INTERNAL' })
      })
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

/** 处理一通来电：先对暗号，再按路径分活 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  options: BackendOptions,
): Promise<void> {
  // 每个请求都要带暗号，因为 HTTP 是"无记忆"的：处理完这通电话就忘了
  // 你是谁，没有"开头自我介绍一次、后面就认识你"。暗号装在请求头里
  // （请求头 = "名字: 值"的清单，HTTP 只管搬运不问含义；
  //   x-session-token 是我们自己起的名字）。
  // 暗号不对就统一拒接，不说"差一点就对了"（那是在帮试探者缩小范围）
  if (!isAuthorized(req, token)) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' })
    return
  }
  // 基础健康检查：主进程开机后拿它自测通道
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true })
    return
  }
  // 模型自测：真的调一次模型（固定短提示词），验证密钥管道和供应商连通
  if (req.method === 'GET' && req.url === '/model/ping') {
    const apiKey = options.modelApiKey
    if (!apiKey) {
      sendJson(res, 503, { ok: false, code: 'NO_KEY' })
      return
    }
    try {
      const call = options.callModel ?? callModelOnce
      const result: ModelCallResult = await call(
        apiKey,
        '请只回复两个字：收到',
        AbortSignal.timeout(30_000),
      )
      sendJson(res, 200, { ok: true, text: result.text, usage: result.usage ?? null })
    } catch (error) {
      // 模型调用失败：把原因带回去（错误消息里不会有密钥），主进程记日志
      const message = error instanceof Error ? error.message : 'unknown'
      sendJson(res, 502, { ok: false, code: 'MODEL_ERROR', message })
    }
    return
  }
  // 和直连自测分开：这条路径必须经过 eve 的会话与模型执行流程。
  if (req.method === 'GET' && req.url === '/agent/ping') {
    if (!options.modelApiKey) {
      sendJson(res, 503, { ok: false, code: 'NO_KEY' })
      return
    }
    if (!options.pingAgent) {
      sendJson(res, 503, { ok: false, code: 'AGENT_UNAVAILABLE' })
      return
    }
    try {
      const result = await options.pingAgent(AbortSignal.timeout(30_000))
      sendJson(res, 200, { ok: true, text: result.text, usage: result.usage ?? null })
    } catch {
      // 不传原始错误消息；第三方错误对象可能包含提示词或密钥。
      sendJson(res, 502, { ok: false, code: 'AGENT_ERROR' })
    }
    return
  }
  // 运行期换密钥（03 §3「重新配置」通道）：收 POST + JSON { apiKey }。
  // 密钥经「已通过会话令牌认证的本地通道」进来，同样不进日志
  if (req.method === 'POST' && req.url === '/model/key') {
    let apiKey: unknown
    try {
      const body = (await readJsonBody(req)) as { apiKey?: unknown }
      apiKey = body?.apiKey
    } catch {
      // 解析失败或体积超限，统一按参数不合法回绝
      sendJson(res, 400, { ok: false, code: 'INVALID_INPUT' })
      return
    }
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'INVALID_INPUT' })
      return
    }
    if (!options.rotateModelKey) {
      sendJson(res, 503, { ok: false, code: 'AGENT_UNAVAILABLE' })
      return
    }
    try {
      await options.rotateModelKey(apiKey.trim())
      sendJson(res, 200, { ok: true })
    } catch {
      // 换钥失败只报错误码，不转发原始错误内容
      sendJson(res, 502, { ok: false, code: 'AGENT_ERROR' })
    }
    return
  }
  // 数据库自测（T01 贯通）：GET 读、POST 写。写的内容是真实业务值
  // （app_state 的共享记忆版本号 +1）；「后台重启后 GET 仍读到 POST
  // 写入的值」就是数据落了盘、不是只活在内存里的证据。这对端点是
  // 贯通自测用的，T04 建正式应用接口时再收编或替换。
  if (req.method === 'GET' && req.url === '/db/ping') {
    if (!options.db) {
      sendJson(res, 503, { ok: false, code: 'DB_UNAVAILABLE' })
      return
    }
    try {
      sendJson(res, 200, { ok: true, globalMemoryEpoch: options.db.readEpoch() })
    } catch {
      // 读失败只报错误码；数据库报错原文可能带表结构细节，不转发
      sendJson(res, 502, { ok: false, code: 'DB_ERROR' })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/db/ping') {
    if (!options.db) {
      sendJson(res, 503, { ok: false, code: 'DB_UNAVAILABLE' })
      return
    }
    try {
      sendJson(res, 200, { ok: true, globalMemoryEpoch: options.db.bumpEpoch() })
    } catch {
      // 写失败同样只报错误码；失败绝不假装成功（01 R17）
      sendJson(res, 502, { ok: false, code: 'DB_ERROR' })
    }
    return
  }
  sendJson(res, 404, { ok: false, code: 'NOT_FOUND' })
}
