/**
 * eve 的模型配置：每次模型执行前，从本进程内存里取密钥。
 * 编译时不读密钥，也不把带密钥的模型对象放进工作流检查点（落盘的执行进度）。
 * 正式角色和聊天历史由后台信封提供；固定连通探针继续兼容 T01。
 */
import { defineAgent, defineDynamic } from 'eve'
import { wrapLanguageModel } from 'ai'
import { waitSecrets } from './lib/stdin-secrets'
import { createCompanionContextMiddleware } from './lib/context-middleware'
import { createModelStepLimitMiddleware } from './lib/model-step-limit'
import { createCompanionLanguageModel } from '../src/agent/model'
import { readRuntimeModelConnection } from '../src/shared/model-settings'

export default defineAgent({
  // 禁止复制自己启动子 Agent；本项目的记忆整理也不是第二个自由行动的 Agent。
  tool: false,
  // eve 默认带文件、Shell 和网页工具；陪伴助手不应获得这些能力。
  defaultTools: false,
  model: defineDynamic({
    events: {
      // step.started 在真正执行模型的那一步内运行，返回的模型不进入检查点。
      // session.started / turn.started 只允许返回模型名字，不能拿来装运行期密钥。
      'step.started': async (event) => {
        const { modelApiKey } = await waitSecrets()
        if (!modelApiKey) throw new Error('E_NO_MODEL_KEY')
        // 环境变量只读公开配置，密钥来自内存管道。共用创建入口让聊天和连接测试发送同样的供应商参数。
        const connection = readRuntimeModelConnection(process.env.COMPANION_MODEL_CONFIG, process.env.COMPANION_MODEL_BASE_URL)
        return {
          model: wrapLanguageModel({
            model: createCompanionLanguageModel(modelApiKey, connection),
            middleware: [createModelStepLimitMiddleware(event), createCompanionContextMiddleware({
              modelWindowTokens: connection.contextWindowTokens, outputReserveTokens: connection.outputReserveTokens,
            })],
          }),
          // 与后台共用已核对的模型窗口；输入仍留回复空间，不另加应用小额度。
          modelContextWindowTokens: connection.contextWindowTokens,
        }
      },
    },
  }),
})
