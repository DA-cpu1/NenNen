/**
 * 界面的起点：找到页面里的 #root 空位，把 React 组件挂上去。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// 全局样式（颜色变量、基础重置）——import 一个 CSS 文件，Vite 会把它
// 自动塞进页面；不 import 的话组件里 var(--bg) 这些变量不存在
import './global.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 挂载点')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
