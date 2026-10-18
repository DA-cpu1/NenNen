/**
 * eve 的测试 Agent 配置：每次模型执行前，从本进程内存里取密钥。
 * 编译时不读密钥，也不把带密钥的模型对象放进工作流检查点（落盘的执行进度）。
 * 这里只验证运行通路；正式角色和聊天历史以后由应用数据库提供。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { defineAgent, defineDynamic } from 'eve'
import { waitSecrets } from './lib/stdin-secrets'

export default defineAgent({
  // 禁止复制自己启动子 Agent；本项目的记忆整理也不是第二个自由行动的 Agent。
  tool: false,
  // eve 默认带文件、Shell 和网页工具；陪伴助手不应获得这些能力。
  defaultTools: false,
  model: defineDynamic({
    events: {
      // step.started 在真正执行模型的那一步内运行，返回的模型不进入检查点。
      // session.started / turn.started 只允许返回模型名字，不能拿来装运行期密钥。
      'step.started': async () => {
        const { modelApiKey } = await waitSecrets()
        if (!modelApiKey) throw new Error('E_NO_MODEL_KEY')
        const provider = createOpenAICompatible({
          name: 'zhipu',
          // 测试可指定本机模拟接口；此环境变量只放公开地址，不放密钥或令牌。
          baseURL: process.env.COMPANION_MODEL_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: modelApiKey,
          includeUsage: true,
        })
        return {
          model: provider('glm-5.3-flash'),
          // 这是本次短消息验证的暂定预算，尚不是供应商容量的实测结论。
          modelContextWindowTokens: 128_000,
        }
      },
    },
  }),
})
