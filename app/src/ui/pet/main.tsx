/**
 * 桌宠窗口界面的起点：找到 #root，把桌宠组件挂上去。
 * 和 src/ui/main.tsx 是同一套写法，只是挂的组件不同——
 * 两个窗口 = 两份入口页面（pet.html / index.html），各挂各的组件。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import PetWindow from './PetWindow'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 挂载点')
}

createRoot(container).render(
  <StrictMode>
    <PetWindow />
  </StrictMode>,
)
