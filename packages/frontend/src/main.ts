import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'; 
import App from './App.vue';
import router from './router'; 
import i18n from './i18n';
import { useAuthStore } from './stores/auth.store'; 
import { useSettingsStore } from './stores/settings.store'; 
import { useAppearanceStore } from './stores/appearance.store'; 
import { prewarmWorkspaceSync } from './stores/workspaceSync.store';
import './style.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import 'splitpanes/dist/splitpanes.css';
import { installDebugBridge } from './debug';
import { showBootFailure, isChunkLoadError } from './utils/bootFallback';
import { isDesktopApp } from './utils/platform';
import { migrateLegacyFolderStorage } from './utils/legacyStorageMigration';


const pinia = createPinia(); // 创建 Pinia 实例
pinia.use(piniaPluginPersistedstate); // 使用持久化插件

const app = createApp(App);

app.use(pinia); // 使用配置好的 Pinia 实例
// 开发期调试桥：捕获组件异常 / console 落盘 / 暴露 window.__NEXUS__（生产构建自动剔除）
installDebugBridge(app);

// 注意：在状态初始化完成前，暂时不 use(router)
app.use(i18n); // 使用 i18n



// --- 应用初始化逻辑 ---
// 使用 async IIFE 来允许顶层 await
(async () => {
  // 「标签 → 文件夹」改名：先把浏览器里的旧缓存清掉，别让 store 读到 tag_ids 结构
  migrateLegacyFolderStorage();

  const authStore = useAuthStore(pinia); // 实例化 Auth Store
  // **提前实例化 AppearanceStore 以确保 immediate watcher 运行**
  const appearanceStore = useAppearanceStore(pinia);

  try {
    console.log("[main.ts] 开始检查设置和认证状态...");
    // 1. 同时检查设置和认证状态，并等待它们完成
    // 确保 checkAuthStatus 可以在 needsSetup=true 时也能安全运行并返回正确状态
    await Promise.all([
      authStore.checkSetupStatus(),
      authStore.checkAuthStatus()
    ]);
    console.log(`[main.ts] 状态检查完成: needsSetup=${authStore.needsSetup}, isAuthenticated=${authStore.isAuthenticated}`);

    // 2. 如果不需要设置且用户已认证，则加载用户特定数据
    if (!authStore.needsSetup && authStore.isAuthenticated) {
      console.log("[main.ts] 用户已认证且无需设置，加载设置和外观数据...");
      const settingsStore = useSettingsStore(pinia);
      try {
        await Promise.all([
          settingsStore.loadInitialSettings(),
          appearanceStore.loadInitialAppearanceData() // 调用已实例化的 store 的 action
        ]);
        console.log("[main.ts] 用户设置和外观数据加载完成。");
      } catch (error) {
         console.error("[main.ts] 加载用户设置或外观数据失败:", error);
         // 加载失败也继续，可能使用默认值或显示错误
      }
    } else if (authStore.needsSetup) {
        console.log("[main.ts] 需要初始设置，将由路由守卫处理重定向。");
        // 不再手动 router.push('/setup')
    } else {
        console.log("[main.ts] 用户未认证或无需设置。");
        // appearanceStore 已实例化，其 immediate watcher 会应用默认主题
    }

    // 3. 状态和数据准备就绪后，再启用路由并挂载应用
    console.log("[main.ts] 状态准备就绪，启用路由并挂载应用...");
    // 路由懒加载的 chunk 挂掉时，导航永远不会 settle：以前的表现是整页空白、控制台无输出，
    // 手机上根本看不出发生了什么。这里先接住错误，给个能重试的提示。
    router.onError((error) => {
      console.error('[main.ts] 路由加载失败:', error);
      showBootFailure(
        isChunkLoadError(error) ? '页面资源加载失败' : '页面打开失败',
        isChunkLoadError(error)
          ? '前端代码没有下载完整（弱网或缓存里的旧文件）。请检查网络后重新加载。'
          : error
      );
    });
    /**
     * 挂载前预取「恢复工作区要用的四个往返」—— 让首帧就带着会话。
     *
     * 以前是「挂载 → 画出空工作区 → WorkspaceView.onMounted 才拉快照 → 再填会话」，
     * 用户看到的就是"先一个没有会话的空工作区，等一下会话才长出来"。
     * 现在这些请求和路由 chunk 的下载**并行**发起：等挂载时数据已经在内存里，
     * 恢复流程 `await` 到的全是已 resolve 的 promise，只剩微任务 —— 标签在首帧绘制前
     * 就已经在 store 里了。不是拿遮罩去盖住中间那段，而是把那段本身消掉。
     *
     * 幂等：路由守卫与 WorkspaceView 都会触发，只有第一次真的发请求。
     */
    let workspacePrefetch: Promise<void> | null = null;
    const beginWorkspacePrefetch = (): Promise<void> => {
      if (workspacePrefetch) return workspacePrefetch;
      workspacePrefetch = prewarmWorkspaceSync();
      return workspacePrefetch;
    };

    // 本守卫注册在 router/index.ts 的守卫之后，看到的是「重定向后的最终目标」；
    // 而懒加载 chunk 是在 beforeEach 之后才发起的 —— 正好可以在这里抢跑。
    router.beforeEach((to) => {
      if (to.name === 'Workspace') void beginWorkspacePrefetch();
      return true;
    });

    app.use(router); // 在这里启用路由，确保守卫能获取到最新状态
    await router.isReady(); // 等待路由初始化完成 (特别是异步路由加载)

    // 直达工作区时，等预取齐了再挂载。上限 5 秒：接口挂了也不能让整页永远白着，
    // 超时就正常挂载 —— 恢复流程取用未完成的预取，行为退化成"数据晚到一点"。
    if (router.currentRoute.value.name === 'Workspace') {
      await Promise.race([
        beginWorkspacePrefetch().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    app.mount('#app');
    console.log("[main.ts] 应用已挂载。");

  } catch (error) {
    // 捕获初始化过程中的意外错误
    console.error("[main.ts] 应用初始化过程中发生严重错误:", error);
    // 即使发生严重错误，也尝试启用路由并挂载应用，可能显示错误页面或回退状态
    try {
      app.use(router); // 确保路由被添加
    } catch (_) {}
    try {
      await router.isReady();
    } catch (routerError) {
      console.error("[main.ts] 路由初始化失败:", routerError);
    }
    try {
      app.mount('#app');
    } catch (mountError) {
      console.error("[main.ts] 挂载失败:", mountError);
    }
    showBootFailure('应用启动失败', error);
  }
// --- PWA Service Worker Registration ---
  // ⚠️ 这段以前挂在 `window.addEventListener('load')` 上：它位于一堆 await（认证、设置、
  // 路由 chunk、挂载）之后，真正执行到时 load 早就 fire 完了 —— 监听器永远不会触发，
  // SW 实际上从来没注册成功过（`getRegistrations()` 恒为 []）。要么直接注册，要么别写。
  //
  // 现在只在「生产构建的网页版」注册：
  //   - dev（vite 5173）：SW 会把源码模块缓存住，改代码不生效，绝对不要；
  //   - 桌面端：更新靠替换安装包，多一层缓存只会制造"版本对不上"；
  //   - 网页版：/sw.js 已改成「导航网络优先 + /assets 缓存优先 + /api、/ws 不碰」，
  //     普通刷新必拿最新 index.html，见 public/sw.js 顶部说明。
  if (import.meta.env.PROD && 'serviceWorker' in navigator && !isDesktopApp()) {
    const registerServiceWorker = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((registration) => {
          console.log('[SW] 注册成功，scope=', registration.scope);
        })
        .catch((error) => {
          console.warn('[SW] 注册失败:', error);
        });
    };
    if (document.readyState === 'complete') {
      registerServiceWorker();
    } else {
      window.addEventListener('load', registerServiceWorker, { once: true });
    }
  }
})();
