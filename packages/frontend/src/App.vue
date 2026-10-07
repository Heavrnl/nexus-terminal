<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { ref, onMounted, onUnmounted, watch, nextTick, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from './stores/auth.store';
import { useDeviceDetection } from './composables/useDeviceDetection';
import { useVisualViewport } from './composables/useVisualViewport';
import { useSettingsStore } from './stores/settings.store';
import { useAppearanceStore } from './stores/appearance.store';
import { useLayoutStore } from './stores/layout.store';
import { useFocusSwitcherStore } from './stores/focusSwitcher.store';
import { useSessionStore } from './stores/session.store';
import { useFavoritePathsStore } from './stores/favoritePaths.store';
import { storeToRefs } from 'pinia';
import UINotificationDisplay from './components/UINotificationDisplay.vue';
import FileEditorOverlay from './components/FileEditorOverlay.vue';
import StyleCustomizer from './components/StyleCustomizer.vue';
import MobileStyleCustomizerModal from './components/MobileStyleCustomizerModal.vue';
import FocusSwitcherConfigurator from './components/FocusSwitcherConfigurator.vue';
import RemoteDesktopModal from './components/RemoteDesktopModal.vue';
import VncModal from './components/VncModal.vue';
import ConfirmDialog from './components/common/ConfirmDialog.vue';
import { useDialogStore } from './stores/dialog.store';

const { t } = useI18n();
const authStore = useAuthStore();
const settingsStore = useSettingsStore();
const appearanceStore = useAppearanceStore();
const layoutStore = useLayoutStore();
const focusSwitcherStore = useFocusSwitcherStore(); // +++ 实例化焦点切换 Store +++
const sessionStore = useSessionStore(); // +++ 实例化 Session Store +++
const dialogStore = useDialogStore(); // +++ 实例化 DialogStore +++
const { state: dialogState } = storeToRefs(dialogStore); 
const favoritePathsStore = useFavoritePathsStore(); // +++ 实例化 favoritePathsStore +++
const { isAuthenticated } = storeToRefs(authStore);
const { showPopupFileEditorBoolean } = storeToRefs(settingsStore);
const { isStyleCustomizerVisible } = storeToRefs(appearanceStore);
const { isLayoutVisible, isHeaderVisible } = storeToRefs(layoutStore); // 添加 isHeaderVisible
const { isConfiguratorVisible: isFocusSwitcherVisible } = storeToRefs(focusSwitcherStore);
const { isRdpModalOpen, rdpConnectionInfo, isVncModalOpen, vncConnectionInfo } = storeToRefs(sessionStore); // +++ 获取 RDP 和 VNC 状态 +++
const { isMobile } = useDeviceDetection();

const route = useRoute();
const navRef = ref<HTMLElement | null>(null);
const underlineRef = ref<HTMLElement | null>(null);

// +++ 存储上一次由切换器聚焦的 ID +++
const lastFocusedIdBySwitcher = ref<string | null>(null);
const isAltPressed = ref(false); // 跟踪 Alt 键是否按下
const altShortcutKey = ref<string | null>(null);
// --- 移除 shortcutTriggeredInKeyDown 标志 ---

const updateUnderline = async () => {
  await nextTick(); // 等待 DOM 更新
  if (navRef.value && underlineRef.value) {
    const activeLink = navRef.value.querySelector('.router-link-exact-active') as HTMLElement;
    if (activeLink) {
      const offsetBottom = 2; // 下划线距离文字底部的距离 (px)
      underlineRef.value.style.left = `${activeLink.offsetLeft}px`;
      underlineRef.value.style.width = `${activeLink.offsetWidth}px`;
      // underlineRef.value.style.top = `${activeLink.offsetTop + activeLink.offsetHeight + offsetBottom}px`; // 移除 top 设置
      underlineRef.value.style.opacity = '1'; // Make it visible
    } else {
      underlineRef.value.style.opacity = '0'; // Hide if no active link (e.g., on login page if not a nav link)
    }
  }
};

onMounted(() => {
  // Initial position update
  // Use setTimeout to ensure styles are applied and elements have dimensions
  setTimeout(updateUnderline, 100);

  // +++ 全局 Alt 键监听器 +++
  window.addEventListener('keydown', handleAltKeyDown); // +++ 监听 keydown 设置状态 +++
  window.addEventListener('keyup', handleGlobalKeyUp);   // +++ 监听 keyup 执行切换 +++
  
  // PWA Install Prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    console.log('[App.vue] beforeinstallprompt event fired. Browser will handle install prompt.');
  });

  window.addEventListener('appinstalled', () => {
    console.log('[App.vue] PWA was installed');
  });
  
  // +++ 加载 Header 可见性状态 +++
  layoutStore.loadHeaderVisibility();

  // +++ 初始化移动端视觉视口与防滚动锁定 +++
  const { initVisualViewport } = useVisualViewport();
  initVisualViewport();

});

// +++ 监听用户认证状态，登录后初始化收藏路径 +++
watch(isAuthenticated, (loggedIn) => {
  if (loggedIn) {
    favoritePathsStore.initializeFavoritePaths(t);
  }
}, { immediate: true });

// +++ 卸载钩子以移除监听器 +++
onUnmounted(() => {
  window.removeEventListener('keydown', handleAltKeyDown); // +++ 移除 keydown 监听 +++
  window.removeEventListener('keyup', handleGlobalKeyUp);   // +++ 移除 keyup 监听 +++
});


// *** 计算属性，判断是否在 workspace 路由 ***
const isWorkspaceRoute = computed(() => route.path === '/workspace');

watch(route, () => {
  updateUnderline();
}, { immediate: true }); // *** 确保 immediate: true 存在 ***


const handleLogout = () => {
  authStore.logout();
};

// 打开样式自定义器的方法现在直接调用 store action
const openStyleCustomizer = () => {
  appearanceStore.toggleStyleCustomizer(true);
};

// 关闭样式自定义器的方法现在也调用 store action
const closeStyleCustomizer = () => {
  appearanceStore.toggleStyleCustomizer(false);
};

// +++ 处理 Alt 键按下的事件处理函数，并记录快捷键 +++
const handleAltKeyDown = async (event: KeyboardEvent) => { // +++ 改为 async +++
  if (!isWorkspaceRoute.value) return; // 只在 workspace 路由下执行
  // 只在 Alt 键首次按下时设置状态
  if (event.key === 'Alt' && !event.repeat) {
    isAltPressed.value = true;
    altShortcutKey.value = null;
    // console.log('[App] Alt key pressed down.');
  } else if (isAltPressed.value && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
    // 如果 Alt 正被按住，且按下了非修饰键 (移除 !shortcutTriggeredInKeyDown 检查)
    let key = event.key;
    if (key.length === 1) key = key.toUpperCase();

    if (/^[a-zA-Z0-9]$/.test(key)) {
        altShortcutKey.value = key; // 记录按键
        const shortcutString = `Alt+${key}`;
        console.log(`[App] KeyDown: Alt+${key} detected. Checking shortcut: ${shortcutString}`);
        const targetId = focusSwitcherStore.getFocusTargetIdByShortcut(shortcutString);

        if (targetId) {
            console.log(`[App] KeyDown: Shortcut match found. Targeting ID: ${targetId}`);
            event.preventDefault(); // 阻止默认行为 (如菜单)
            const success = await focusSwitcherStore.focusTarget(targetId); // +++ 立即尝试聚焦 +++
            if (success) {
                console.log(`[App] KeyDown: Successfully focused ${targetId} via shortcut.`);
                lastFocusedIdBySwitcher.value = targetId;
                // --- 移除设置标志位 ---
            } else {
                console.log(`[App] KeyDown: Failed to focus ${targetId} via shortcut action.`);
                // 聚焦失败，可以选择是否取消 Alt 状态，暂时不处理，让 keyup 重置
            }
        } else {
            console.log(`[App] KeyDown: No configured shortcut found for ${shortcutString}.`);
            // 没有匹配的快捷键，可以选择取消 Alt 状态以允许默认行为，或保持状态等待 keyup
            // isAltPressed.value = false;
            // altShortcutKey.value = null;
        }
    } else {
        // 按下无效键 (非字母数字)，取消 Alt 状态
        isAltPressed.value = false;
        altShortcutKey.value = null;
        // --- 移除重置标志位 ---
        console.log('[App] KeyDown: Alt sequence cancelled by non-alphanumeric key press.');
    }
  } else if (isAltPressed.value && ['Control', 'Shift', 'Meta'].includes(event.key)) {
      // 按下其他修饰键，取消 Alt 状态
      isAltPressed.value = false;
      altShortcutKey.value = null;
      // --- 移除重置标志位 ---
      console.log('[App] KeyDown: Alt sequence cancelled by other modifier key press.');
  }
};

// +++ 全局键盘事件处理函数，监听 keyup，优先处理快捷键 +++
const handleGlobalKeyUp = async (event: KeyboardEvent) => {
  if (!isWorkspaceRoute.value) return; // 只在 workspace 路由下执行
  if (event.key === 'Alt') {
    const altWasPressed = isAltPressed.value;
    const triggeredShortcutKey = altShortcutKey.value; // 记录松开时是否有记录的快捷键

    // 总是重置状态
    isAltPressed.value = false;
    altShortcutKey.value = null;
    // --- 移除重置标志位 ---

    if (altWasPressed && triggeredShortcutKey === null) {
      // 如果 Alt 之前是按下的，并且没有记录到有效的快捷键，则执行顺序切换
      console.log('[App] KeyUp: Alt released without a valid shortcut key captured. Attempting sequential focus switch.');
      event.preventDefault(); // 仅在执行顺序切换时阻止默认行为

      // --- 顺序切换逻辑 (保持不变) ---
      let currentFocusId: string | null = lastFocusedIdBySwitcher.value;
      console.log(`[App] Sequential switch. Last focused by switcher: ${currentFocusId}`);

      if (!currentFocusId) {
          const activeElement = document.activeElement as HTMLElement;
          if (activeElement && activeElement.hasAttribute('data-focus-id')) {
              currentFocusId = activeElement.getAttribute('data-focus-id');
              console.log(`[App] Sequential switch. Found focus ID from activeElement: ${currentFocusId}`);
          } else {
              console.log(`[App] Sequential switch. Could not determine current focus ID.`);
          }
      }

      const order = focusSwitcherStore.sequenceOrder; // ++ 使用新的 sequenceOrder state ++
      if (order.length === 0) { // ++ 检查新的 state ++
        console.log('[App] No focus sequence configured.');
        return;
      }

      let focused = false;
      for (let i = 0; i < order.length; i++) { // ++ Use order.length for loop condition ++
        const nextFocusId = focusSwitcherStore.getNextFocusTargetId(currentFocusId);
        if (!nextFocusId) {
          console.warn('[App] Could not determine next focus target ID in sequence.');
          break;
        }

        console.log(`[App] Sequential switch. Trying to focus target ID: ${nextFocusId}`);
        const success = await focusSwitcherStore.focusTarget(nextFocusId);

        if (success) {
          console.log(`[App] Successfully focused ${nextFocusId} sequentially.`);
          lastFocusedIdBySwitcher.value = nextFocusId;
          focused = true;
          break;
        } else {
          console.log(`[App] Failed to focus ${nextFocusId} sequentially. Trying next...`);
          currentFocusId = nextFocusId;
        }
      }

      if (!focused) {
        console.log('[App] Cycled through sequence, no target could be focused.');
        lastFocusedIdBySwitcher.value = null;
      }
      // --- 顺序切换逻辑结束 ---

    } else if (altWasPressed && triggeredShortcutKey !== null) {
      console.log(`[App] KeyUp: Alt released after capturing key '${triggeredShortcutKey}'. Shortcut logic handled in keydown. No sequential switch.`);
      // 快捷键逻辑已在 keydown 处理，keyup 时无需操作，也不阻止默认行为（除非特定需要）
    } else {
      // Alt 松开，但 isAltPressed 已经是 false (例如被其他键取消了)
      console.log('[App] KeyUp: Alt released, but sequence was already cancelled or not active.');
    }
  }
};

// +++ 辅助函数：检查元素是否可见且可聚焦 +++
const isElementVisibleAndFocusable = (element: HTMLElement): boolean => {
  if (!element) return false;
  // 检查元素是否在 DOM 中，并且没有 display: none
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  // 检查元素或其父元素是否被禁用
  if ((element as HTMLInputElement).disabled) return false;
  let parent = element.parentElement;
  while (parent) {
    if ((parent as HTMLFieldSetElement).disabled) return false;
    parent = parent.parentElement;
  }
  // 检查元素是否足够在视口内（粗略检查）
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};



</script>

<template>
  
  <div id="app-container">
    <!-- *** 修改 v-if 条件以使用 isHeaderVisible *** -->
    <!-- Header with Tailwind classes using theme variables -->
    <header v-if="!isWorkspaceRoute || isHeaderVisible" class="sticky top-0 z-10 flex items-center h-14 pl-3 pr-6 bg-header border-b border-border shadow-sm"> <!-- 减少左侧内边距 -->
      <!-- Nav with Tailwind classes -->
      <nav ref="navRef" class="flex items-center justify-between w-full relative"> <!-- Added relative positioning for underline -->
        <!-- Left navigation links with Tailwind classes using theme variables -->
        <div class="flex items-center space-x-1">
          <!-- 项目 Logo -->
          <img src="./assets/logo.png" alt="Project Logo" class="h-10 w-auto"> <!-- 移除右侧外边距，使其更靠左 -->
            <RouterLink to="/" class="inline-flex px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap" active-class="text-link-active bg-nav-active-bg">{{ t('nav.dashboard') }}</RouterLink> <!-- 恢复仪表盘链接, 始终可见 -->
            <RouterLink to="/workspace" class="inline-flex px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap" active-class="text-link-active bg-nav-active-bg">{{ t('nav.terminal') }}</RouterLink> <!-- 保持可见 -->
            <RouterLink to="/connections" class="hidden md:inline-flex px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap" active-class="text-link-active bg-nav-active-bg">{{ t('nav.connections') }}</RouterLink> <!-- 连接管理链接 -->
            <RouterLink to="/proxies" class="hidden md:inline-flex px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap" active-class="text-link-active bg-nav-active-bg">{{ t('nav.proxies') }}</RouterLink> <!-- 移动端隐藏 -->
            <RouterLink to="/notifications" class="hidden md:inline-flex px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap" active-class="text-link-active bg-nav-active-bg">{{ t('nav.notifications') }}</RouterLink> <!-- 移动端隐藏 -->
            <RouterLink to="/audit-logs" class="hidden md:inline-flex px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap" active-class="text-link-active bg-nav-active-bg">{{ t('nav.auditLogs') }}</RouterLink> <!-- 移动端隐藏 -->
            <RouterLink to="/settings" class="inline-flex px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap" active-class="text-link-active bg-nav-active-bg">{{ t('nav.settings') }}</RouterLink> <!-- 保持可见 -->
        </div>
        <!-- Right navigation links with Tailwind classes using theme variables -->
        <div class="flex items-center space-x-1">
          <!-- GitHub Icon (Hide on mobile) -->
          <a v-if="!isMobile" href="https://github.com/Heavrnl/nexus-terminal" target="_blank" rel="noopener noreferrer" title="Heavrnl/nexus-terminal" class="px-2 py-2 rounded-md text-lg text-icon hover:text-icon-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/>
            </svg>
          </a>
          <!-- PWA Install Button - REMOVED FROM HERE -->
          <a href="#" @click.prevent="openStyleCustomizer" :title="t('nav.customizeStyle')" class="px-2 py-2 rounded-md text-lg text-icon hover:text-icon-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out"><i class="fas fa-paint-brush"></i></a>
          <RouterLink v-if="!isAuthenticated" to="/login" class="px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap">{{ t('nav.login') }}</RouterLink>
          <a href="#" v-if="isAuthenticated" @click.prevent="handleLogout" class="px-3 py-2 rounded-md text-sm font-medium text-secondary hover:text-link-hover hover:bg-nav-active-bg hover:no-underline transition duration-150 ease-in-out whitespace-nowrap">{{ t('nav.logout') }}</a>
        </div>
        <!-- Sliding underline element with Tailwind classes using theme variables (JS still controls positioning) -->
        <div ref="underlineRef" class="absolute bottom-0 h-0.5 bg-link-active rounded transition-all duration-300 ease-in-out pointer-events-none opacity-0 transform translate-y-1.5"></div> <!-- Changed translate-y-1 to translate-y-1.5 -->
      </nav>
    </header>

    <main :class="{ 'overflow-hidden': isWorkspaceRoute, 'overflow-y-auto': !isWorkspaceRoute }">
      <!-- 使用 KeepAlive 包裹 RouterView，并指定缓存 WorkspaceView -->
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="['WorkspaceView', 'ConnectionsView']">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>

    <!-- 添加全局通知显示 -->
    <UINotificationDisplay />

    <!-- 根据设置条件渲染全局文件编辑器弹窗 -->
    <FileEditorOverlay v-if="showPopupFileEditorBoolean" :is-mobile="isMobile" />

    <!-- 条件渲染样式自定义器：移动端与桌面端完全解耦渲染 -->
    <MobileStyleCustomizerModal
      v-if="isStyleCustomizerVisible && isMobile"
      @close="closeStyleCustomizer"
    />
    <StyleCustomizer
      v-else-if="isStyleCustomizerVisible && !isMobile"
      @close="closeStyleCustomizer"
    />

    <!-- +++ 条件渲染焦点切换配置器 (使用 v-show 保持实例) +++ -->
    <FocusSwitcherConfigurator
      v-show="isFocusSwitcherVisible"
      :isVisible="isFocusSwitcherVisible"
      @close="focusSwitcherStore.toggleConfigurator(false)"
    />

    <!-- +++ 条件渲染 RDP 模态框 +++ -->
    <RemoteDesktopModal
      v-if="isRdpModalOpen"
      :connection="rdpConnectionInfo"
      @close="sessionStore.closeRdpModal()"
    />

    <!-- +++ 条件渲染 VNC 模态框 +++ -->
    <VncModal
      v-if="isVncModalOpen"
      :connection="vncConnectionInfo"
      @close="sessionStore.closeVncModal()"
    />

    <!-- +++ 全局确认对话框 +++ -->
    <ConfirmDialog
          :visible="dialogState.visible"
          :title="dialogState.title"
          :message="dialogState.message"
          :confirm-text="dialogState.confirmText"
          :cancel-text="dialogState.cancelText"
          :is-loading="dialogState.isLoading"
          @confirm="dialogStore.handleConfirm"
          @cancel="dialogStore.handleCancel"
          @update:visible="(val: boolean) => dialogStore.state.visible = val"
        />

  </div>
</template>

<style scoped>
#app-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  height: var(--visual-viewport-height, 100dvh);
  max-height: var(--visual-viewport-height, 100dvh);
  overflow: hidden;
  font-family: var(--font-family-sans-serif);
}

main {
  flex: 1 1 0%;
  min-height: 0;
  width: 100%;
  position: relative;
}
</style>
