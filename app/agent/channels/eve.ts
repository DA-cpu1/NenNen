/**
 * eve 的「总机前台」配置：eve 自带的 HTTP 接口（发消息、取消、读事件流）
 * 默认锁死不让匿名访问（fail closed），必须配一个「认证器」告诉它怎么
 * 核对来电身份。这个文件就是配那个认证器的地方。
 *
 * 我们的方案和后台总机（src/service/server.ts）同一个思路：开机时后台
 * 服务现场编一个随机令牌，经 stdin 管道第 2 行送进来；此后每次 HTTP 来电
 * 都要在请求头里带同一个令牌，对不上就拒。eve 的健康检查路径
 * （/eve/v1/health）是故意留公开的——它只报「活着没」，不碰任何机密。
 */
import type { AuthFn } from 'eve/channels/auth'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { eveChannel } from 'eve/channels/eve'
import { waitSecrets } from '../lib/stdin-secrets'

/**
 * 核对 Bearer 令牌的认证器。
 * Bearer = 请求头 authorization 里写「Bearer 一串令牌」的携带方式，
 * 和 6a 里调智谱用的同一种格式。
 * 返回值三态（eve 的规矩）：核对通过 → 返回身份对象（放行）；对不上 →
 * 返回 null（跳过，本配置里没有下一个认证器，效果就是 401 拒绝）。
 */
const bearerTokenAuth: AuthFn<Request> = async (request) => {
  const { routeToken } = await waitSecrets()
  // 令牌没送到（管道空）→ 谁都别想进，保持锁死
  if (!routeToken) return null
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null

  // timingSafeEqual：比字符串时「比到第一个不同的字符就提前结束」会泄露
  // 前缀信息给试探者，这个函数保证比完整串、耗时与内容无关。
  // 它只吃等长的 Buffer，先比长度可以——长度不是机密
  const given = Buffer.from(header.slice('Bearer '.length), 'utf-8')
  const expected = Buffer.from(routeToken, 'utf-8')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null
  }

  // 核对通过：登记「来电者是谁」。本项目里 eve 的唯一来电者就是后台服务，
  // 所以写死一个服务身份；正式版多角色时再按后台传来的角色信息细化
  return {
    attributes: {},
    authenticator: 'local-route-token',
    principalId: 'backend-service',
    principalType: 'service',
  }
}

export default eveChannel({
  auth: bearerTokenAuth,
})
