import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth.store'; // 导入 Auth Store

// 路由配置
const routes: Array<RouteRecordRaw> = [
  // 首页/仪表盘 (占位符)
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('../views/DashboardView.vue') // 指向实际的仪表盘组件
    // component: { template: '<div>仪表盘 (建设中)</div>' } // 移除临时占位
  },
  // 登录页面 (占位符)
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/LoginView.vue') // 指向实际的登录组件
  },
  // 新增：代理管理页面
  {
    path: '/proxies',
    name: 'Proxies',
     component: () => import('../views/ProxiesView.vue')
   },
   // 移除：标签管理页面路由
   // {
   //   path: '/tags',
   //   name: 'Tags',
   //   component: () => import('../views/TagsView.vue')
   // },
   // 工作区页面 (不再需要 connectionId 参数)
   {
    path: '/workspace', // 移除动态路由段
    name: 'Workspace',
    component: () => import('../views/WorkspaceView.vue'),
    // props: true // 不再需要传递 props
  },
  // 新增：设置页面
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/SettingsView.vue')
  },
  // 新增：通知管理页面
  {
    path: '/notifications',
    name: 'Notifications',
    component: () => import('../views/NotificationsView.vue')
  },
  // 新增：审计日志页面
  {
    path: '/audit-logs',
    name: 'AuditLogs',
    component: () => import('../views/AuditLogView.vue')
  },
  // 新增：初始设置页面
  {
    path: '/setup',
    name: 'Setup',
    component: () => import('../views/SetupView.vue')
  },
  // 其他路由...
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL), // 使用 HTML5 History 模式
  routes,
});

// 添加全局前置守卫
router.beforeEach(async (to, from, next) => { // 将守卫设为 async
  // 在守卫内部获取 store 实例，确保 Pinia 已初始化
  const authStore = useAuthStore();

  // 0. 确保 setup 状态已检查 (如果尚未加载)
  // needsSetup 初始状态在 store 中是 false，checkSetupStatus 会更新它
  // 我们需要确保在尝试自动登录或执行其他逻辑前，这个状态是准确的。
  // 考虑一种情况：应用首次加载，needsSetup 默认为 false，然后路由守卫执行。
  // 如果 checkSetupStatus 尚未运行，它可能会错误地尝试自动登录。
  // 因此，在关键决策前确保 checkSetupStatus 已运行（或其结果已知）很重要。
  // 更好的做法可能是在 main.ts 或 App.vue onMounted 中优先调用 checkSetupStatus。
  // 此处我们假设，如果 needsSetup 还是其初始值，则先获取它。
  // Pinia store 的 state 通常有默认值，所以直接检查 authStore.needsSetup 即可。
  // 如果 authStore.needsSetup 的初始值能明确表示“未加载”，则可以触发加载。
  // 当前 authStore.needsSetup 默认为 false。
  // 我们需要一个机制来确保 checkSetupStatus() 至少运行一次。
  // 暂时，我们先调用它，如果它内部有防止重复调用的逻辑则更好。
  // 或者，我们可以在 App.vue 中确保它先运行。
  // 为了简单起见，这里先调用一次，后续可以优化。
  if (typeof authStore.needsSetup !== 'boolean' || (to.name !== 'Setup' && from.name === undefined)) { // 粗略判断是否首次加载或状态未知
    // console.log('[Router Guard] Ensuring setup status is checked...');
    // await authStore.checkSetupStatus(); // 确保 setup 状态已加载
  }
  // 实际上，checkSetupStatus 应该在应用更早阶段（如 main.ts 或 App.vue）被调用一次。
  // 此处我们假设它已经被调用，或者其影响会在后续逻辑中体现。

  // 尝试自动登录 (仅当 store 中 isAuthenticated 为 false 且非 Setup 流程)
  if (!authStore.isAuthenticated && !authStore.needsSetup) { // 仅在非 setup 模式且未认证时尝试
    console.log('[Router Guard] Not authenticated and not in setup, attempting auto login...');
    await authStore.attemptAutoLogin(); // 调用新的 action
  }

  // 定义不需要认证的路由名称列表
  const publicRoutes = ['Login', 'Setup'];
  const requiresAuth = !publicRoutes.includes(to.name as string);
  const needsSetup = authStore.needsSetup; // 重新获取最新的 needsSetup 状态

  if (needsSetup && to.name !== 'Setup') {
    // 如果需要设置，但目标不是设置页面，则强制重定向到设置页面
    console.log('[Router Guard] Needs setup, redirecting to /setup');
    next({ name: 'Setup' });
  } else if (!needsSetup && to.name === 'Setup') {
     // 如果不需要设置，但尝试访问设置页面，重定向到登录页或首页
     console.log('[Router Guard] Does not need setup, redirecting from /setup');
     next(authStore.isAuthenticated ? { name: 'Dashboard' } : { name: 'Login' });
  } else if (requiresAuth && !authStore.isAuthenticated && !needsSetup) {
    // 如果需要认证、用户未登录且不需要设置，重定向到登录页
    console.log('[Router Guard] Not authenticated, redirecting to /login');
    next({ name: 'Login' });
  } else if (to.name === 'Login' && authStore.isAuthenticated && !needsSetup) {
    // 如果用户已登录、不需要设置且尝试访问登录页，重定向到仪表盘
    console.log('[Router Guard] Authenticated, redirecting from /login to /');
    next({ name: 'Dashboard' });
  } else {
    // 其他情况（例如访问公共页面，或已登录访问需认证页面）允许导航
    next();
  }
});

export default router;
