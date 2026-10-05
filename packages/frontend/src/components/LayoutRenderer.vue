<script setup lang="ts">
import type { ConnectionInfo } from '../stores/connections.store';
import { computed, defineAsyncComponent, type PropType, type Component, ref, watch, onMounted, onBeforeUnmount, nextTick, type CSSProperties } from 'vue'; // Added onBeforeUnmount, nextTick and CSSProperties
import { useI18n } from 'vue-i18n';
import { useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import '@fortawesome/fontawesome-free/css/all.min.css';
import { Splitpanes, Pane } from 'splitpanes';
import { useLayoutStore, type LayoutNode, type PaneName } from '../stores/layout.store';
import { useSessionStore } from '../stores/session.store';
import { useFileEditorStore } from '../stores/fileEditor.store'; 
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store'; // +++ Import appearance store +++
import { useSidebarResize } from '../composables/useSidebarResize';
import { storeToRefs } from 'pinia';


// --- Props ---
const props = defineProps({
  layoutNode: {
    type: Object as PropType<LayoutNode>,
    required: true,
  },
  // 标识是否为顶层渲染器
  isRootRenderer: {
    type: Boolean,
    default: false,
  },
  // 传递必要的上下文数据，避免在递归中重复获取
  activeSessionId: {
    type: String as PropType<string | null>,
    required: false, // 改为非必需
    default: null,   // 提供默认值 null
  },
  // *** 接收编辑器相关 props ***
  editorTabs: {
    type: Array as PropType<any[]>, // 使用 any[] 简化，或导入具体类型
    default: () => [],
  },
  activeEditorTabId: {
    type: String as PropType<string | null>,
    default: null,
  },
  // +++ Add layoutLocked prop +++
  layoutLocked: {
    type: Boolean,
    default: false,
  },
});



const layoutStore = useLayoutStore();
const sessionStore = useSessionStore();
const fileEditorStore = useFileEditorStore(); 
const settingsStore = useSettingsStore(); 
const { t } = useI18n();
const subscribeToWorkspaceEvent = useWorkspaceEventSubscriber();
const unsubscribeFromWorkspaceEvent = useWorkspaceEventOff();

// +++ Appearance Store Refs +++
const appearanceStore = useAppearanceStore();
const {
  terminalBackgroundImage,
  isTerminalBackgroundEnabled,
  currentTerminalBackgroundOverlayOpacity,
  terminalCustomHTML,
} = storeToRefs(appearanceStore);

const { activeSession } = storeToRefs(sessionStore);
const { workspaceSidebarPersistentBoolean, getSidebarPaneWidth } = storeToRefs(settingsStore);
const { sidebarPanes } = storeToRefs(layoutStore);
const { orderedTabs: editorTabsFromStore, activeTabId: activeEditorTabIdFromStore } = storeToRefs(fileEditorStore); // <-- Get editor state

// --- Sidebar State ---
const activeLeftSidebarPane = ref<PaneName | null>(null);
const activeRightSidebarPane = ref<PaneName | null>(null);
const leftSidebarPanelRef = ref<HTMLElement | null>(null); // +++ Ref for left panel +++
const rightSidebarPanelRef = ref<HTMLElement | null>(null); // +++ Ref for right panel +++
const leftResizeHandleRef = ref<HTMLElement | null>(null); // +++ Ref for left handle +++
const rightResizeHandleRef = ref<HTMLElement | null>(null); // +++ Ref for right handle +++
const customHtmlLayerRef = ref<HTMLElement | null>(null); // +++ Ref for custom HTML layer +++

// --- Component Mapping ---
// 使用 defineAsyncComponent 优化加载，并映射 PaneName 到实际组件
const componentMap: Record<PaneName, Component> = {
  connections: defineAsyncComponent(() => import('./WorkspaceConnectionList.vue')),
  terminal: defineAsyncComponent(() => import('./Terminal.vue')),
  commandBar: defineAsyncComponent(() => import('./CommandInputBar.vue')),
  fileManager: defineAsyncComponent(() => import('./FileManager.vue')),
  editor: defineAsyncComponent(() => import('./FileEditorContainer.vue')),
  statusMonitor: defineAsyncComponent(() => import('./StatusMonitor.vue')),
  commandHistory: defineAsyncComponent(() => import('../views/CommandHistoryView.vue')),
  quickCommands: defineAsyncComponent(() => import('../views/QuickCommandsView.vue')),
  dockerManager: defineAsyncComponent(() => import('./DockerManager.vue')), // <--- 添加 dockerManager 映射
  suspendedSshSessions: defineAsyncComponent(() => import('../views/SuspendedSshSessionsView.vue')),
  multiLineCommandInput: defineAsyncComponent(() => import('./MultiLineCommandInput.vue')),
};

// --- Computed ---
// 获取当前节点对应的组件实例 (用于主布局)
const currentMainComponent = computed(() => {
  if (props.layoutNode.type === 'pane' && props.layoutNode.component) {
    return componentMap[props.layoutNode.component] || null;
  }
  return null;
});

// 获取当前激活的左侧侧栏组件实例
const currentLeftSidebarComponent = computed(() => {
  return activeLeftSidebarPane.value ? componentMap[activeLeftSidebarPane.value] : null;
});

// 获取当前激活的右侧侧栏组件实例
const currentRightSidebarComponent = computed(() => {
  return activeRightSidebarPane.value ? componentMap[activeRightSidebarPane.value] : null;
});

const hasSshSessions = computed(() => {
 // Check if any session has a terminalManager (indicates SSH)
 for (const [_, sessionState] of sessionStore.sessions) {
   if (sessionState.terminalManager) {
     return true;
   }
 }
 return false;
});

// 面板标签 (Similar to LayoutConfigurator)
const paneLabels = computed(() => ({
  connections: t('layout.pane.connections', '连接列表'),
  terminal: t('layout.pane.terminal', '终端'),
  commandBar: t('layout.pane.commandBar', '命令栏'),
  fileManager: t('layout.pane.fileManager', '文件管理器'),
  editor: t('layout.pane.editor', '编辑器'),
  statusMonitor: t('layout.pane.statusMonitor', '状态监视器'),
  commandHistory: t('layout.pane.commandHistory', '命令历史'),
  quickCommands: t('layout.pane.quickCommands', '快捷指令'),
  dockerManager: t('layout.pane.dockerManager', 'Docker 管理器'),
  suspendedSshSessions: t('layout.panes.suspendedSshSessions', '挂起会话管理'),
  multiLineCommandInput: t('layout.pane.multiLineCommandInput', '多行命令输入'),
}));


// 为特定组件计算需要传递的 Props (主布局)
// 注意：这是一个简化示例，实际可能需要更复杂的逻辑来传递正确的 props
const componentProps = computed(() => {
  const componentName = props.layoutNode.component;
  const currentActiveSession = activeSession.value; // 获取当前活动会话

  if (!componentName) return {};

  switch (componentName) {
    // --- 为需要转发事件的组件添加事件绑定 ---
    // 'terminal' case removed as props are now passed directly in the v-for loop
    case 'fileManager':
      // 仅当有活动会话时才返回实际 props，否则返回空对象
      if (!currentActiveSession) return {};
      // 传递 instanceId (使用布局节点的 ID), sessionId, dbConnectionId
      // 移除 sftpManager 和 wsDeps
      // +++ 提供 instanceId 的备用值 +++
      const instanceId = props.layoutNode.id || `fm-main-${props.activeSessionId ?? 'unknown'}`;
      return {
         sessionId: props.activeSessionId ?? '', // 确保 sessionId 不为 null
         instanceId: instanceId, // 使用计算出的 instanceId (包含备用值)
         dbConnectionId: currentActiveSession.connectionId,
         // sftpManager: currentActiveSession.sftpManager, // 移除 sftpManager，因为它现在由 FileManager 内部管理
         wsDeps: { // 恢复 wsDeps
           sendMessage: currentActiveSession.wsManager.sendMessage,
           onMessage: currentActiveSession.wsManager.onMessage,
           isConnected: currentActiveSession.wsManager.isConnected, // 恢复 isConnected
           isSftpReady: currentActiveSession.wsManager.isSftpReady // 恢复 isSftpReady
         },
         class: 'pane-content', // class 可以保留，或者在模板中处理
         // FileManager 可能也需要转发事件，例如文件操作相关的，暂时省略
      };
    case 'statusMonitor':
       // 始终渲染，传递 activeSessionId
       return {
         activeSessionId: props.activeSessionId, // 传递 activeSessionId
         class: 'pane-content',
       };
    case 'editor':
      // FileEditorContainer 需要 tabs, activeTabId, sessionId, 并转发事件
      return {
        tabs: props.editorTabs, // 从 WorkspaceView 传入
        activeTabId: props.activeEditorTabId, // 从 WorkspaceView 传入
        sessionId: props.activeSessionId,
        class: 'pane-content',
        // --- 移除事件转发 ---
      };
    case 'commandBar':
       return {
         class: 'pane-content',
         // --- 移除事件转发 ---
       };
    case 'connections':
       return {
         class: 'pane-content',
         // --- 移除事件转发 ---
       };
     case 'commandHistory':
    case 'quickCommands':
       return {
         class: 'flex flex-col flex-grow h-full overflow-auto', // 移除 pane-content，保留填充类
         // --- 移除事件转发 ---
       };
   case 'dockerManager':
     // DockerManager 可能不需要 session 信息
     return {
       class: 'flex-grow h-full overflow-hidden', // <-- 修改：添加 flex-grow 和 h-full，并保留 overflow-hidden
       // 假设 DockerManager 会发出 'docker-command' 事件
       // onDockerCommand: (payload: { containerId: string; command: 'up' | 'down' | 'restart' | 'stop' }) => emit('dockerCommand', payload),
       // 暂时不添加事件转发，等组件实现后再确定
     };
   case 'suspendedSshSessions':
    case 'multiLineCommandInput':
     return {
       class: 'flex flex-col flex-grow h-full overflow-auto', // 与 quickCommands 类似
     };
   default:
     return { class: 'pane-content' };
 }
});

// --- New computed property for sidebar component props and events ---
// 修改以接收 side 参数，用于确定 instanceId
const sidebarProps = computed(() => (paneName: PaneName | null, side: 'left' | 'right') => {
 if (!paneName) return {};

 const baseProps = { class: 'sidebar-pane-content' }; // Base props for all sidebar components

 switch (paneName) {
   case 'editor':
     return {
       ...baseProps,
       tabs: editorTabsFromStore.value, // Access .value for refs from storeToRefs
       activeTabId: activeEditorTabIdFromStore.value, // Access .value
       sessionId: props.activeSessionId,
       // --- 移除事件转发 ---
     };
   case 'connections':
     return {
       ...baseProps,
       // --- 移除事件转发 ---
     };
   case 'fileManager':
     // Only provide props if there's an active session
     if (activeSession.value) {
       // 传递 instanceId (根据 side), sessionId, dbConnectionId
       // 移除 sftpManager 和 wsDeps
       const instanceId = side === 'left' ? 'sidebar-left' : 'sidebar-right';
       return {
         ...baseProps,
         sessionId: activeSession.value.sessionId,
         instanceId: instanceId, // 使用 'sidebar-left' 或 'sidebar-right'
         dbConnectionId: activeSession.value.connectionId,
         // sftpManager: activeSession.value.sftpManager, // 移除 sftpManager
         wsDeps: { // 恢复 wsDeps
           sendMessage: activeSession.value.wsManager.sendMessage,
           onMessage: activeSession.value.wsManager.onMessage,
           isConnected: activeSession.value.wsManager.isConnected, // 直接传递 ref
           isSftpReady: activeSession.value.wsManager.isSftpReady  // 直接传递 ref
         },
       };
     } else {
       return baseProps; // Return only base props if no active session
     }
   case 'statusMonitor':
     // 始终渲染，传递 activeSessionId
     return {
       ...baseProps,
       activeSessionId: props.activeSessionId, // 传递 activeSessionId
     };
    // Add cases for other components if they need specific props or event forwarding in the sidebar
    // case 'commandHistory': return { ...baseProps, onExecuteCommand: (cmd: string) => emit('sendCommand', cmd) };
    // case 'quickCommands': return { ...baseProps, onExecuteCommand: (cmd: string) => emit('sendCommand', cmd) };
    default:
      return baseProps; // Return only base props for other components
  }
});


// --- Methods ---
// 处理 Splitpanes 大小调整事件
const handlePaneResize = (eventData: { panes: Array<{ size: number; [key: string]: any }> }) => {
  // +++ 更详细的日志 +++
  // +++ Log the entire layoutNode object if ID is undefined +++
  if (props.layoutNode && typeof props.layoutNode.id === 'undefined') {
    console.warn(`[LayoutRenderer DEBUG] handlePaneResize triggered but props.layoutNode.id is undefined. Full layoutNode prop:`, JSON.parse(JSON.stringify(props.layoutNode)));
  }
  // console.log(`[LayoutRenderer DEBUG] handlePaneResize triggered for node ID: ${props.layoutNode?.id}, direction: ${props.layoutNode?.direction ?? 'N/A'}`); // Use optional chaining for safety
  // console.log('[LayoutRenderer DEBUG] Splitpanes resized event object:', eventData);
  const paneSizes = eventData.panes; // 从事件对象中提取 panes 数组

  // console.log('[LayoutRenderer DEBUG] Extracted paneSizes:', paneSizes); // 打印提取出的数组

  // +++ Use optional chaining for safety +++
  if (props.layoutNode?.type === 'container' && props.layoutNode?.children) {
    // 确保 paneSizes 是一个数组
    if (!Array.isArray(paneSizes)) {
      console.error('[LayoutRenderer] handlePaneResize: 从事件对象提取的 panes 不是数组:', paneSizes);
      return;
    }
    // 构建传递给 store action 的数据结构
    const childrenSizes = paneSizes.map((paneInfo, index) => ({
        index: index,
        size: paneInfo.size
    }));

    // +++ 调用 store action 前的日志 +++
    // console.log(`[LayoutRenderer DEBUG] Calling layoutStore.updateNodeSizes for node ID: ${props.layoutNode.id} with sizes:`, JSON.parse(JSON.stringify(childrenSizes)));
    // 调用 store action 来更新节点大小
    layoutStore.updateNodeSizes(props.layoutNode.id, childrenSizes);
  } else {
    // console.log(`[LayoutRenderer DEBUG] handlePaneResize ignored for node ID: ${props.layoutNode.id} (type: ${props.layoutNode.type})`);
  }
};

// 打开/切换侧栏面板
const toggleSidebarPane = (side: 'left' | 'right', paneName: PaneName) => {
  if (side === 'left') {
    activeLeftSidebarPane.value = activeLeftSidebarPane.value === paneName ? null : paneName;
    if (activeLeftSidebarPane.value) activeRightSidebarPane.value = null; // Close other side
  } else {
    activeRightSidebarPane.value = activeRightSidebarPane.value === paneName ? null : paneName;
    if (activeRightSidebarPane.value) activeLeftSidebarPane.value = null; // Close other side
  }
};

// 关闭所有侧栏
const closeSidebars = () => {
  activeLeftSidebarPane.value = null;
  activeRightSidebarPane.value = null;
};

// 监听 activeSessionId 的变化，如果会话切换，则关闭侧栏 (可选行为)
watch(() => props.activeSessionId, () => {
    // closeSidebars(); // 取消注释以在切换会话时关闭侧栏
});

// +++ 新方法：处理主内容区域点击，用于非固定模式下关闭侧边栏 +++
const handleMainAreaClick = () => {
  // 仅当侧边栏激活且不处于固定模式时才关闭
  if ((activeLeftSidebarPane.value || activeRightSidebarPane.value) && !workspaceSidebarPersistentBoolean.value) {
    closeSidebars();
  }
};

// --- Debug Watcher for sidebarPanes from store ---
watch(sidebarPanes, (newVal) => {
  // console.log('[LayoutRenderer] Received updated sidebarPanes from store:', JSON.parse(JSON.stringify(newVal)));
}, { deep: true, immediate: true }); // Immediate to log initial value

// --- Icon Helper ---
const getIconClasses = (paneName: PaneName): string[] => {
  switch (paneName) {
    case 'connections': return ['fas', 'fa-network-wired'];
    case 'fileManager': return ['fas', 'fa-folder-open'];
    case 'commandHistory': return ['fas', 'fa-history'];
    case 'quickCommands': return ['fas', 'fa-bolt'];
    case 'dockerManager': return ['fab', 'fa-docker']; // Use 'fab' for Docker
    case 'editor': return ['fas', 'fa-file-alt'];
    case 'statusMonitor': return ['fas', 'fa-tachometer-alt'];
    case 'suspendedSshSessions': return ['fas', 'fa-pause-circle'];
    case 'multiLineCommandInput': return ['fas', 'fa-file-code']; // 图标：暂停圈
    // Add other specific icons here if needed
    default: return ['fas', 'fa-question-circle']; // Default icon
  }
};


// --- Sidebar Resize Logic ---
onMounted(() => {
  const handleStabilizedTerminalResize = ({ sessionId, width, height }: { sessionId: string; width: number; height: number }) => {
    if (props.layoutNode.component === 'terminal' && sessionId === props.activeSessionId && customHtmlLayerRef.value) {
      customHtmlLayerRef.value.style.width = `${width}px`;
      customHtmlLayerRef.value.style.height = `${height}px`;
    }
  };
  subscribeToWorkspaceEvent('terminal:stabilizedResize', handleStabilizedTerminalResize);



  // Left Sidebar Resize
  useSidebarResize({
    sidebarRef: leftSidebarPanelRef,
    handleRef: leftResizeHandleRef,
    side: 'left',
    onResizeEnd: (newWidth) => {
      console.log(`Left sidebar resize ended. New width: ${newWidth}px`);
      // +++ Update specific pane width +++
      if (activeLeftSidebarPane.value) {
        settingsStore.updateSidebarPaneWidth(activeLeftSidebarPane.value, `${newWidth}px`);
      }
    },
  });

  // Right Sidebar Resize
  useSidebarResize({
    sidebarRef: rightSidebarPanelRef,
    handleRef: rightResizeHandleRef,
    side: 'right',
    onResizeEnd: (newWidth) => {
      console.log(`Right sidebar resize ended. New width: ${newWidth}px`);
      // +++ Update specific pane width +++
      if (activeRightSidebarPane.value) {
        settingsStore.updateSidebarPaneWidth(activeRightSidebarPane.value, `${newWidth}px`);
      }
    },
  });
});

// +++ Background Image Style +++
const terminalBackgroundImageStyle = computed((): CSSProperties => {
  if (isTerminalBackgroundEnabled.value && terminalBackgroundImage.value && props.layoutNode.component === 'terminal') {
    const backendUrl = import.meta.env.VITE_API_BASE_URL || '';
    const imagePath = terminalBackgroundImage.value;
    const fullImageUrl = `${backendUrl}${imagePath}`;
    return {
      backgroundImage: `url(${fullImageUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      zIndex: 0, // Base layer for background
    };
  }
  return {
    backgroundImage: 'none',
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    zIndex: 0,
  };
});

// +++ Function to execute scripts (migrated from Terminal.vue) +++
const executeScriptsInElement = (container: HTMLElement) => {
  if (!container) return;
  const scripts = Array.from(container.getElementsByTagName('script'));
  scripts.forEach((oldScript) => {
    const newScript = document.createElement('script');
    Array.from(oldScript.attributes).forEach(attr => {
      newScript.setAttribute(attr.name, attr.value);
    });
    if (oldScript.textContent) {
      newScript.textContent = oldScript.textContent;
    }
    if (oldScript.parentNode) {
      oldScript.parentNode.replaceChild(newScript, oldScript);
    } else {
       container.appendChild(newScript); // Fallback, though less likely if script was in container
    }
  });
};

// +++ Watch for changes in terminalCustomHTML and execute scripts (migrated) +++
watch(terminalCustomHTML, (newHtmlContent, oldHtmlContent) => {
  if (props.layoutNode.component !== 'terminal') return; // Only for terminal panes

  if (newHtmlContent === oldHtmlContent && oldHtmlContent !== undefined) {
    return;
  }
  nextTick(() => {
    const container = customHtmlLayerRef.value;
    if (container) {
      if (newHtmlContent) {
        executeScriptsInElement(container);
      }
    }
  });
}, { immediate: true });


onBeforeUnmount(() => {
  const handleStabilizedTerminalResizeHandler = ({ sessionId, width, height }: { sessionId: string; width: number; height: number }) => {
    if (props.layoutNode.component === 'terminal' && sessionId === props.activeSessionId && customHtmlLayerRef.value) {
      customHtmlLayerRef.value.style.width = `${width}px`;
      customHtmlLayerRef.value.style.height = `${height}px`;
    }
  };
  unsubscribeFromWorkspaceEvent('terminal:stabilizedResize', handleStabilizedTerminalResizeHandler); // Use the same handler reference if possible
});



</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden">
    <!-- Left Sidebar Buttons -->
    <div class="flex flex-col bg-sidebar py-1 z-10 flex-shrink-0 border-r border-border" v-if="isRootRenderer && sidebarPanes.left.length > 0">
        <button
            v-for="pane in sidebarPanes.left"
            :key="`left-${pane}`"
            @click="toggleSidebarPane('left', pane)"
            :class="['flex items-center justify-center w-10 h-10 mb-1 text-text-secondary hover:bg-hover hover:text-foreground transition-colors duration-150 cursor-pointer text-lg',
                     { 'bg-primary text-white hover:bg-primary-dark': activeLeftSidebarPane === pane }]"
            :title="paneLabels[pane] || pane"
        >
            <i :class="getIconClasses(pane)"></i>
        </button>
    </div>

    <!-- Main Layout Area -->
    <div class="relative flex-grow h-full overflow-hidden" @click="handleMainAreaClick">
        <div class="flex flex-col h-full w-full overflow-hidden" :data-node-id="layoutNode.id">
            <!-- Container Node -->
            <template v-if="layoutNode.type === 'container' && layoutNode.children && layoutNode.children.length > 0">
              <splitpanes
                  :horizontal="layoutNode.direction === 'vertical'"
                  :class="['default-theme flex-grow', { 'layout-locked': props.layoutLocked }]"
                  @resized="handlePaneResize"
                  :push-other-panes="false"
                  :dbl-click-splitter="!props.layoutLocked"
              >
                  <pane
                    v-for="childNode in layoutNode.children"
                    :key="childNode.id"
                    :size="childNode.size ?? (100 / layoutNode.children.length)"
                    :min-size="5"
                    class="flex flex-col overflow-hidden bg-background"
                  >
                    <LayoutRenderer
                        :layout-node="childNode"
                        :is-root-renderer="false"
                        :active-session-id="activeSessionId"
                        :editor-tabs="editorTabs"
                        :active-editor-tab-id="activeEditorTabId"
                        class="flex-grow overflow-auto"
                    />
                  </pane>
              </splitpanes>
            </template>

            <!-- Pane Node -->
            <template v-else-if="layoutNode.type === 'pane'">
                <!-- Terminal Pane: Render ALL SSH sessions, show only the active one -->
               <template v-if="layoutNode.component === 'terminal'">
                   <div
                       class="terminal-pane-container relative flex-grow overflow-hidden"
                       :class="{ 'has-global-terminal-background': isTerminalBackgroundEnabled, 'bg-background': !isTerminalBackgroundEnabled }"
                   >
                       <!-- Shared Background Layers -->
                       <div
                           v-if="isTerminalBackgroundEnabled"
                           class="shared-terminal-background-layers"
                           style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0;"
                       >
                           <!-- Background Image -->
                           <div
                               class="terminal-background-image-layer"
                               :style="terminalBackgroundImageStyle"
                           ></div>
                           <!-- Color Overlay -->
                           <div
                               class="terminal-background-overlay-layer"
                               :style="{
                                   position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
                                   backgroundColor: `rgba(0, 0, 0, ${currentTerminalBackgroundOverlayOpacity})`,
                                   zIndex: 1, pointerEvents: 'none'
                               }"
                           ></div>
                           <!-- Custom HTML -->
                           <div
                               ref="customHtmlLayerRef"
                               v-if="terminalCustomHTML"
                               class="terminal-custom-html-layer"
                               style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2;"
                               v-html="terminalCustomHTML"
                           ></div>
                       </div>

                       <!-- Terminal Instances -->
                       <template v-for="[sessionId, sessionState] in sessionStore.sessions" :key="sessionId">
                           <template v-if="sessionState.terminalManager">
                               <keep-alive>
                                   <component
                                       :is="componentMap.terminal"
                                       v-show="sessionId === activeSessionId"
                                       :session-id="sessionId"
                                       :is-active="sessionId === activeSessionId"
                                       :class="['terminal-instance-wrapper absolute inset-0 w-full h-full', { 'terminal-transparent': isTerminalBackgroundEnabled }]"
                                       :style="{ zIndex: 3 }"
                                       :options="{}"
                                   />
                               </keep-alive>
                           </template>
                       </template>
                       <!-- Placeholder -->
                       <div v-if="!activeSessionId || !hasSshSessions"
                            class="absolute inset-0 flex justify-center items-center text-center text-text-secondary bg-header text-sm p-4"
                            :style="{ zIndex: 4 }">
                           <div class="flex flex-col items-center justify-center p-8 w-full h-full">
                               <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                               <span class="text-lg font-medium text-text-secondary mb-2">{{ activeSessionId ? t('layout.noSshSessionActive.title', '无活动的 SSH 会话') : t('layout.noActiveSession.title') }}</span>
                               <div class="text-xs text-text-secondary mt-2">{{ activeSessionId ? t('layout.noSshSessionActive.message', '请激活一个 SSH 会话以使用此终端面板。') : t('layout.noActiveSession.message') }}</div>
                           </div>
                       </div>
                   </div>
               </template>
                 <!-- FileManager -->
                 <template v-else-if="layoutNode.component === 'fileManager'">
                        <component
                          :is="currentMainComponent"
                          :key="layoutNode.id"
                          v-bind="componentProps"
                          class="flex-grow overflow-auto"
                          v-if="activeSession"
                        >
                        </component>
                     <div v-if="!activeSession" class="flex-grow flex justify-center items-center text-center text-text-secondary bg-header text-sm p-4">
                      <div class="flex flex-col items-center justify-center p-8 w-full h-full">
                        <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                        <span class="text-lg font-medium text-text-secondary mb-2">{{ t('layout.noActiveSession.title') }}</span>
                        <div class="text-xs text-text-secondary mt-2">{{ t('layout.noActiveSession.message') }}</div>
                      </div>
                    </div>
                </template>
                <!-- StatusMonitor -->
                <template v-else-if="layoutNode.component === 'statusMonitor'">
                     <keep-alive v-if="activeSessionId">
                        <component
                          :is="currentMainComponent"
                          v-bind="componentProps"
                          class="flex-grow overflow-auto"
                        />
                     </keep-alive>
                     <div v-else class="flex-grow flex justify-center items-center text-center text-text-secondary bg-header text-sm p-4">
                      <div class="flex flex-col items-center justify-center p-8 w-full h-full">
                        <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                        <span class="text-lg font-medium text-text-secondary mb-2">{{ t('layout.noActiveSession.title') }}</span>
                        <div class="text-xs text-text-secondary mt-2">{{ t('layout.noActiveSession.message') }}</div>
                      </div>
                    </div>
                </template>
                <!-- Other Panes -->
                <template v-else-if="currentMainComponent">
                     <component
                      :is="currentMainComponent"
                      v-bind="componentProps"
                      :class="['flex-grow overflow-auto', componentProps.class]"
                    />
                </template>
                <!-- Invalid Pane Component -->
                <div v-else class="flex-grow flex justify-center items-center text-center text-red-600 bg-red-100 text-sm p-4">
                    无效面板组件: {{ layoutNode.component || '未指定' }} (ID: {{ layoutNode.id }})
                </div>
            </template>

             <!-- Invalid Node Type -->
             <template v-else>
               <div class="flex-grow flex justify-center items-center text-center text-red-600 bg-red-100 text-sm p-4">
                 无效布局节点 (ID: {{ layoutNode.id }})
               </div>
             </template>
        </div>
    </div>

    <!-- Sidebar Overlay -->
    <div
        :class="['fixed inset-0 bg-transparent pointer-events-none z-[100] transition-opacity duration-300 ease-in-out',
                 {'opacity-100 visible': activeLeftSidebarPane || activeRightSidebarPane, 'opacity-0 invisible': !(activeLeftSidebarPane || activeRightSidebarPane)}]"
    ></div>

    <!-- Left Sidebar Panel -->
    <div ref="leftSidebarPanelRef"
         :class="['fixed top-0 bottom-0 left-0 max-w-[80vw] bg-background z-[110] transition-transform duration-300 ease-in-out flex flex-col overflow-hidden border-r border-border',
                  {'translate-x-0': !!activeLeftSidebarPane, '-translate-x-full': !activeLeftSidebarPane}]"
         :style="{ width: getSidebarPaneWidth(activeLeftSidebarPane) }">
        <div ref="leftResizeHandleRef" class="absolute top-0 bottom-0 w-2 cursor-col-resize z-[120] bg-transparent transition-colors duration-200 ease-in-out hover:bg-primary-light right-[-4px]"></div>
        <button class="absolute top-1 right-2 p-1 text-text-secondary hover:text-foreground cursor-pointer text-2xl leading-none z-10" @click="closeSidebars" title="Close Sidebar">&times;</button>
        <KeepAlive>
            <div :key="`left-sidebar-content-${activeLeftSidebarPane ?? 'none'}`" class="relative flex flex-col flex-grow overflow-hidden pt-10"> <!-- Added pt-10 -->
                <component
      
                        v-if="currentLeftSidebarComponent && activeLeftSidebarPane && (activeLeftSidebarPane === 'statusMonitor' || activeLeftSidebarPane !== 'fileManager' || activeSession)"
                        :is="currentLeftSidebarComponent"
                        :key="`left-comp-${activeLeftSidebarPane}`"
                        v-bind="sidebarProps(activeLeftSidebarPane, 'left')"
                        class="flex flex-col flex-grow">
                    </component>
                     <!-- 'fileManager' 且无 activeSession 的提示 -->
                    <div v-else-if="activeLeftSidebarPane === 'fileManager' && !activeSession" class="flex flex-col flex-grow justify-center items-center text-center text-text-secondary p-4">
                      <div class="flex flex-col items-center justify-center p-8">
                        <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                        <span class="text-lg font-medium mb-2">{{ t('layout.noActiveSession.title') }}</span>
                        <div class="text-xs mt-2">{{ t('layout.noActiveSession.fileManagerSidebar') }}</div>
                      </div>
                    </div>
                    <!-- 移除 statusMonitor 的 v-else-if -->
                 <div v-else class="flex flex-col flex-grow">
                 </div>
            </div>
        </KeepAlive>
    </div>

    <!-- Right Sidebar Panel -->
     <div ref="rightSidebarPanelRef"
          :class="['fixed top-0 bottom-0 right-0 max-w-[80vw] bg-background z-[110] transition-transform duration-300 ease-in-out flex flex-col overflow-hidden border-l border-border',
                   {'translate-x-0': !!activeRightSidebarPane, 'translate-x-full': !activeRightSidebarPane}]"
          :style="{ width: getSidebarPaneWidth(activeRightSidebarPane) }">
        <div ref="rightResizeHandleRef" class="absolute top-0 bottom-0 w-2 cursor-col-resize z-[120] bg-transparent transition-colors duration-200 ease-in-out hover:bg-primary-light left-[-4px]"></div>
        <button class="absolute top-1 right-2 p-1 text-text-secondary hover:text-foreground cursor-pointer text-2xl leading-none z-10" @click="closeSidebars" title="Close Sidebar">&times;</button>
        <KeepAlive>
            <div :key="`right-sidebar-content-${activeRightSidebarPane ?? 'none'}`" class="relative flex flex-col flex-grow overflow-hidden pt-10"> <!-- Added pt-10 -->
                <component
                        v-if="currentRightSidebarComponent && activeRightSidebarPane && (activeRightSidebarPane === 'statusMonitor' || activeRightSidebarPane !== 'fileManager' || activeSession)"
                        :is="currentRightSidebarComponent"
                        :key="`right-comp-${activeRightSidebarPane}`"
                        v-bind="sidebarProps(activeRightSidebarPane, 'right')"
                        class="flex flex-col flex-grow">
                    </component>
                     <!-- 'fileManager' 且无 activeSession 的提示 -->
                    <div v-else-if="activeRightSidebarPane === 'fileManager' && !activeSession" class="flex flex-col flex-grow justify-center items-center text-center text-text-secondary p-4">
                      <div class="flex flex-col items-center justify-center p-8">
                        <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                        <span class="text-lg font-medium mb-2">{{ t('layout.noActiveSession.title') }}</span>
                        <div class="text-xs mt-2">{{ t('layout.noActiveSession.fileManagerSidebar') }}</div>
                      </div>
                    </div>
                    <!-- 移除 statusMonitor 的 v-else-if -->
                 <div v-else class="flex flex-col flex-grow">
                 </div>
            </div>
        </KeepAlive>
    </div>

     <!-- Right Sidebar Buttons -->
    <div class="flex flex-col bg-sidebar py-1 z-10 flex-shrink-0 border-l border-border" v-if="isRootRenderer && sidebarPanes.right.length > 0">
         <button
             v-for="pane in sidebarPanes.right"
            :key="`right-${pane}`"
            @click="toggleSidebarPane('right', pane)"
            :class="['flex items-center justify-center w-10 h-10 mb-1 text-text-secondary hover:bg-hover hover:text-foreground transition-colors duration-150 cursor-pointer text-lg',
                     { 'bg-primary text-white hover:bg-primary-dark': activeRightSidebarPane === pane }]"
            :title="paneLabels[pane] || pane"
        >
             <i :class="getIconClasses(pane)"></i>
        </button>
    </div>

  </div>
</template>



<style>

.splitpanes.default-theme .splitpanes__splitter {
  background-image: none !important; /* Ensure no background image in normal state */
  z-index: 5; /* Ensure splitter is above terminal content and its overlays */
}
.splitpanes.default-theme .splitpanes__splitter:hover { /* Apply hover style to the pseudo-element */
  background-color: transparent !important; /* Make splitter transparent on hover */
  background-image: none !important; /* Ensure no background image on hover */
  position: relative;
  box-sizing: border-box;
}

.splitpanes.default-theme .splitpanes__splitter:hover::before {
  background-color: var(--primary-color-light) !important; /* Highlight on hover */
}
.splitpanes__splitter:before {
  content: ""; /* Ensure content for pseudo-element */
  display: block; /* Ensure it takes space */
  width: 100%; /* Fill splitter width */
  height: 100%; /* Fill splitter height */
  background-color: var(--border-color); /* Set background to border color */
  border: none !important; /* Ensure no extra borders */
  /* Ensure it still occupies space and has cursor */
  position: relative;
  box-sizing: border-box;
  transition: background-color 0.1s ease-in-out;
}

/* Ensure ::after pseudo-element doesn't interfere */
.splitpanes.default-theme .splitpanes__splitter::after {
  display: none !important;
}

/* Vertical splitter width */
.splitpanes--vertical > .splitpanes__splitter {
  border-color: var(--border-color) !important;
  width: 1px !important;
  z-index: 5 !important; /* Ensure z-index for vertical splitters */
}
/* Horizontal splitter height */
.splitpanes--horizontal > .splitpanes__splitter {
  border-color: var(--border-color) !important;
  height: 1px !important;
  z-index: 5 !important; /* Ensure z-index for horizontal splitters */
}

/* --- Styles for Locked Layout --- */
.splitpanes.layout-locked .splitpanes__splitter {
  pointer-events: none !important; /* Disable dragging */
  cursor: default !important; /* Change cursor */
  background-color: var(--border-color) !important; /* Ensure no hover effect */
}

.splitpanes.layout-locked .splitpanes__splitter:hover {
  background-color: var(--border-color) !important; /* Override hover effect */
}

.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent {
  background-color: transparent !important; /* 使 Terminal.vue 的最外层容器背景透明 */
}

.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent .terminal-inner-container .xterm-viewport,
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent .terminal-inner-container .xterm-screen {
  background-color: transparent !important;
}


</style>

