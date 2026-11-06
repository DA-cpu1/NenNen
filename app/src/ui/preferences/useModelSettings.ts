/** 窗口统一读取公开模型状态，聊天和设置共用一份结果，不读取或保存密钥。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelSettingsOverview } from '../../shared/model-settings'

/**
 * 首次读取并订阅主进程的状态通知；较早返回的旧请求不能覆盖新结果。
 * @returns 公开状态、读取错误和显式重读操作
 */
export function useModelSettings() {
  const [overview, setOverview] = useState<ModelSettingsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const reload = useCallback(async () => {
    const request = ++sequence.current
    try {
      const result = await window.appApi?.getModelSettings()
      if (request !== sequence.current) return
      if (result?.ok && result.data) { setOverview(result.data); setError(null) }
      else setError(result?.code ?? 'CHANNEL_MISSING')
    } catch { if (request === sequence.current) setError('CHANNEL_UNAVAILABLE') }
  }, [])
  useEffect(() => {
    void reload()
    const unsubscribe = window.appApi?.onModelSettingsChanged(() => void reload())
    return () => { sequence.current += 1; unsubscribe?.() }
  }, [reload])
  return { overview, error, reload }
}
