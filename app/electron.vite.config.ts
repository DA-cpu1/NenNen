/**
 * electron-vite 构建配置：主进程 / 预加载 / 界面三段构建。
 * 目录按规格 03 §4：desktop 放主进程与预加载、ui 放界面，因此覆盖默认的 src/main、src/renderer 约定。
 */
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  // 桌面主进程 + 后台服务子进程入口：同为 Node 环境一起构建
  // 输出按入口名分目录：out/main/index.js、out/service/index.js（entryFileNames 按入口键命名）
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/desktop/main.ts'),
          service: resolve(__dirname, 'src/service/index.ts'),
        },
        // 输出目录已是 out/main，文件名按入口键直出：index.js、service.js
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  // 预加载脚本：输出到 out/preload，由主进程在 webPreferences 里引用
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/desktop/preload.ts') },
      },
    },
  },
  // 界面：React，根目录 src/ui，输出 out/renderer
  // electron-vite 6 要求显式指定入口（不再自动查找 index.html）
  renderer: {
    root: 'src/ui',
    plugins: [react()],
    build: {
      rollupOptions: {
        // 两个界面入口：index 状态窗（T01）、pet 桌宠透明窗（T02 角色小样）。
        // 开发服务器上多入口页面的地址就是「/入口名.html」
        input: {
          index: resolve(__dirname, 'src/ui/index.html'),
          pet: resolve(__dirname, 'src/ui/pet.html'),
        },
      },
    },
  },
})
