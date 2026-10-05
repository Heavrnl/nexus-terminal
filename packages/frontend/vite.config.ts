import { defineConfig } from 'vite';
import { pilot } from 'vite-plugin-pilot';
import vue from '@vitejs/plugin-vue';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';
import tailwindcss from '@tailwindcss/vite'
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    pilot({ locale: 'zh' }),
    vue(),
    tailwindcss(),
    // @ts-ignore because the plugin type might not perfectly match Vite's expected PluginOption type
    (monacoEditorPlugin as any).default({})
  ],
  server: {
    proxy: {
      // 将所有 /api 开头的请求代理到后端服务器
      '/api': {
        target: 'http://localhost:3001', // 后端服务器地址
        changeOrigin: true, // 需要虚拟主机站点
        // 可选：如果后端 API 路径没有 /api 前缀，可以在这里重写路径
        // rewrite: (path) => path.replace(/^\/api/, '')
      },
      // 将所有 /uploads 开头的请求也代理到后端服务器
      '/uploads': {
        target: 'http://localhost:3001', // 后端服务器地址
        changeOrigin: true, // 对于静态资源通常也建议开启
        // 通常不需要重写静态资源的路径
      },
      '/ws': {
        target: 'ws://localhost:3001', // 后端 WebSocket 服务器地址
        ws: true,
        changeOrigin: true,
      }
    }
  }
})
