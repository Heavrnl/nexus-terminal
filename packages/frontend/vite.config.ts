import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';
import tailwindcss from '@tailwindcss/vite'
// 多实例联调（同时开 web 端和桌面端）时，第二份 dev server 指向自己的后端端口。
// 不设环境变量就是原来的 3001，行为不变。
const backendPort = process.env.NEXUS_BACKEND_PORT || '3001';
const httpTarget = `http://localhost:${backendPort}`;
const wsTarget = `ws://localhost:${backendPort}`;

// 两个 dev server 同开时不能共用 node_modules/.vite：一方重新预构建会把另一方的
// 缓存目录整个删掉，直接互相踩崩。用环境变量给每份实例指到自己的目录。
const cacheDir = process.env.NEXUS_VITE_CACHE_DIR || 'node_modules/.vite';

// 桌面端 UI 联调：浏览器里跑不了 Tauri，只能靠标记让 isDesktopApp() 认成桌面端。
// 走 ?platform=desktop 刷新一次就丢了（路由会吞掉 query），所以直接注入。
// 只在 dev server 且显式设置 NEXUS_FORCE_DESKTOP=1 时生效，打包产物不受影响。
const desktopShimPlugin = {
  name: 'nexus-desktop-shim',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    if (process.env.NEXUS_FORCE_DESKTOP !== '1') return html;
    return html.replace(
      '<head>',
      '<head>\n    <script>window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};</script>'
    );
  }
};

// https://vitejs.dev/config/
export default defineConfig({
  cacheDir,
  plugins: [
    vue(),
    tailwindcss(),
    // @ts-ignore because the plugin type might not perfectly match Vite's expected PluginOption type
    (monacoEditorPlugin as any).default({}),
    desktopShimPlugin as any
  ],
  build: {
    // IronRDP 的 WASM 打包产物里有顶层 await（探测 WebCodecs H.264 支持），
    // 默认 target(es2020) 不支持 TLA，会直接构建失败。
    target: 'es2022'
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' }
  },
  server: {
    // 默认仅监听本机回环地址，防止 dev server 的 /@fs/ 等开发调试能力暴露到局域网或公网
    host: '127.0.0.1',
    proxy: {
      // 将所有 /api 开头的请求代理到后端服务器
      '/api': {
        target: httpTarget, // 后端服务器地址
        changeOrigin: true, // 需要虚拟主机站点
        // 可选：如果后端 API 路径没有 /api 前缀，可以在这里重写路径
        // rewrite: (path) => path.replace(/^\/api/, '')
      },
      // 将所有 /uploads 开头的请求也代理到后端服务器
      '/uploads': {
        target: httpTarget, // 后端服务器地址
        changeOrigin: true, // 对于静态资源通常也建议开启
        // 通常不需要重写静态资源的路径
      },
      '/ws': {
        target: wsTarget, // 后端 WebSocket 服务器地址
        ws: true,
        changeOrigin: true,
      }
    }
  }
})
