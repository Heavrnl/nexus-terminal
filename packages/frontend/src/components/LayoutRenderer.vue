<script setup lang="ts">
import type { ConnectionInfo } from '../stores/connections.store';
import { computed, defineAsyncComponent, type PropType, type Component, ref, watch, watchEffect, onMounted, onBeforeUnmount, nextTick, type CSSProperties } from 'vue'; // Added onBeforeUnmount, nextTick and CSSProperties
import { useI18n } from 'vue-i18n';
import { useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import '@fortawesome/fontawesome-free/css/all.min.css';
import { Splitpanes, Pane } from 'splitpanes';
import { useLayoutStore, type LayoutNode, type PaneName } from '../stores/layout.store';
import { useSessionStore } from '../stores/session.store';
import { useFileManagerHostsStore } from '../stores/fileManagerHosts.store';
import { useConnectionsStore } from '../stores/connections.store';
import { useFileEditorStore } from '../stores/fileEditor.store'; 
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store'; // +++ Import appearance store +++
import { useSidebarResize } from '../composables/useSidebarResize';
import { getTerminalPaneIdsInLayout } from '../utils/layoutTree';
import RecentConnectionsPanel from './RecentConnectionsPanel.vue';
import { isDesktopApp } from '../utils/platform';
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
  /**
   * 「最近连接」面板只画在一个终端面板里（一般是第一个），
   * 由根渲染器算好后往下传；否则四分屏会有四份一模一样的列表。
   */
  recentConnectionsPaneId: {
    type: String as PropType<string | null>,
    default: null,
  },
});



const layoutStore = useLayoutStore();
const sessionStore = useSessionStore();
const fileManagerHostsStore = useFileManagerHostsStore();
const connectionsStore = useConnectionsStore();
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
// 端口转发只在桌面端可用；web 端即便老布局里存了也要过滤掉
const isDesktop = isDesktopApp();
const visibleLeftSidebarPanes = computed(() => sidebarPanes.value.left.filter(p => p !== 'portForward' || isDesktop));
const visibleRightSidebarPanes = computed(() => sidebarPanes.value.right.filter(p => p !== 'portForward' || isDesktop));

/**
 * 「最近连接」只挂在**一个**终端面板里：
 * 根渲染器取布局树里第一个终端面板的 id，再逐层往下传；
 * 子渲染器直接用传下来的值，避免自己重新算（树是同一棵，但没必要每层都遍历）。
 */
const recentPanelPaneId = computed<string | null>(() => {
  if (props.recentConnectionsPaneId) return props.recentConnectionsPaneId;
  if (!props.isRootRenderer) return null;
  return getTerminalPaneIdsInLayout(props.layoutNode)[0] ?? null;
});
const showRecentConnections = computed(() => !props.activeSessionId
  && !!props.layoutNode?.id
  && props.layoutNode.id === recentPanelPaneId.value);

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
  portForward: defineAsyncComponent(() => import('../views/PortForwardView.vue')),
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
   if (sessionState.kind === 'ssh' && sessionState.terminalManager) {
     return true;
   }
 }
 return false;
});

/**
 * 只保留 SSH 会话。
 *
 * 文件管理器 / 状态监控这些面板都是"一个会话一份实例"地常驻渲染的，
 * RDP/VNC 会话没有 SSH 通道也没有 SFTP，把它们算进来会凭空挂一个
 * 连不上的文件管理器（每次切到远程标签都在后台报错）。
 */
const sshSessions = computed(() =>
  Array.from(sessionStore.sessions.entries()).filter(([, sessionState]) => sessionState.kind === 'ssh')
);

/**
 * 主布局里文件管理器 pane 的实例 ID。
 * 与模板里传给 FileManager 的 instance-id 必须严格一致，否则找不到自己的主机绑定。
 */
const mainPaneInstanceId = computed(() => props.layoutNode.id || 'main-fm');

/**
 * 文件管理器 pane 当前该显示哪条会话。
 *
 * 没绑定主机 → 跟随**本布局**的会话（默认行为，也就是"每个布局里的文件管理器先看自己那台"）；
 * 绑定了 → 显示那台主机的会话，**即使活动标签已经切到别的机器**。
 *
 * 绑定按「所属会话」隔离：在 A 会话的文件管理器切到 C，打开 B 会话时它仍然是 B 自己。
 * 早期绑定只按 paneId 存，而各会话的布局树都从同一预设克隆（pane id 相同），
 * 于是一处切换全站生效 —— 那是 bug，不是特性。
 */
const effectiveFileManagerSessionId = computed(() => {
  if (props.layoutNode.component !== 'fileManager') return props.activeSessionId;
  return (
    fileManagerHostsStore.sessionIdFor(mainPaneInstanceId.value, props.activeSessionId)
    || props.activeSessionId
  );
});

/** 左右侧栏的文件管理器各自独立绑定，互不影响（同样按本布局的会话隔离） */
const sidebarFileManagerSessionId = computed(() => ({
  left: fileManagerHostsStore.sessionIdFor('sidebar-left', props.activeSessionId) || props.activeSessionId,
  right: fileManagerHostsStore.sessionIdFor('sidebar-right', props.activeSessionId) || props.activeSessionId,
}));

/**
 * 补建无终端会话。
 *
 * 绑定是持久化的（localStorage），但会话不是 —— 刷新后必须先有会话，
 * pane 才认得出自己该显示哪一台。连接列表可能还没拉回来，所以这里显式
 * 依赖 `connections.length`，列表一到就自动补。
 */
watchEffect(() => {
  // 依赖连接列表：它决定 ensureSession 能不能把连接解析成配置
  void connectionsStore.connections.length;

  if (props.layoutNode.component === 'fileManager') {
    const paneId = mainPaneInstanceId.value;
    // 旧格式（全局共享）的绑定由第一个打开该 pane 的布局认领，之后其他布局互不影响
    fileManagerHostsStore.adoptLegacyBinding(paneId, props.activeSessionId);
    if (fileManagerHostsStore.isBound(paneId, props.activeSessionId)) {
      fileManagerHostsStore.restore(paneId, props.activeSessionId);
    }
  }

  const side = activeLeftSidebarPane.value === 'fileManager'
    ? 'sidebar-left'
    : activeRightSidebarPane.value === 'fileManager' ? 'sidebar-right' : null;
  if (side) {
    fileManagerHostsStore.adoptLegacyBinding(side, props.activeSessionId);
    if (fileManagerHostsStore.isBound(side, props.activeSessionId)) {
      fileManagerHostsStore.restore(side, props.activeSessionId);
    }
  }
});

// pane 真的从布局里消失了才释放绑定与它专属的无终端会话；
// 切换标签页不会走到这里（v-show 而已），所以不会把连接关掉。
onBeforeUnmount(() => {
  if (props.layoutNode.component === 'fileManager') {
    void fileManagerHostsStore.release(mainPaneInstanceId.value, props.activeSessionId);
  }
});

// 判断侧栏面板是否必须依赖活动会话（仅 editor 和 fileManager 依赖具体会话，其余如连接列表、快捷指令等均为全局独立面板）
const isSessionDependentSidebarPane = (paneName: PaneName | null): boolean => {
  return paneName === 'editor' || paneName === 'fileManager';
};

// 面板标签 (Similar to LayoutConfigurator)
const paneLabels = computed(() => ({
  connections: t('layout.pane.connections', '主机列表'),
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
  portForward: t('layout.pane.portForward', '端口转发'),
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
       return {
         class: 'flex flex-col flex-grow h-full overflow-auto',
       };
    case 'quickCommands':
       return {
         instanceId: props.layoutNode.id || 'quick-commands-main',
         class: 'flex flex-col flex-grow h-full overflow-auto',
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
    case 'quickCommands':
      return {
        ...baseProps,
        instanceId: side === 'left' ? 'sidebar-left' : 'sidebar-right',
      };
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
    case 'portForward': return ['fas', 'fa-arrow-right-arrow-left']; // 端口转发
    // Add other specific icons here if needed
    default: return ['fas', 'fa-question-circle']; // Default icon
  }
};


// --- 多终端分屏聚焦指示体系 (严格跟随系统界面主题色) ---
const isCurrentTerminalFocused = computed<boolean>(() => {
  return props.layoutNode.component === 'terminal' && layoutStore.activeTerminalPaneId === props.layoutNode.id;
});

// 是否存在多个终端分屏 (仅在多个终端时才展示聚焦指示线，单终端时不显示)
const isMultiTerminalPanes = computed<boolean>(() => {
  return (layoutStore.currentTerminalPaneIds?.length || 0) > 1;
});

// --- 终端尺寸与动态背景画布同步处理 ---
const handleStabilizedTerminalResize = ({ sessionId, width, height, paneId }: { sessionId: string; width: number; height: number; paneId?: string }) => {
  if (paneId && paneId !== props.layoutNode.id) return;
  if (props.layoutNode.component === 'terminal' && sessionId === props.activeSessionId && customHtmlLayerRef.value) {
    // 动态背景容器永远百分之百贴合当前分屏视口，严禁被终端超宽文本列展开尺寸拉伸变形
    customHtmlLayerRef.value.style.width = '100%';
    customHtmlLayerRef.value.style.height = '100%';

    // 仅在当前分屏容器上派发局部自定义事件，严禁派发全局 window.resize，彻底消除全应用级死循环
    customHtmlLayerRef.value.dispatchEvent(new CustomEvent('pane-resize', { detail: { width, height } }));
  }
};

// --- Sidebar Resize Logic ---
onMounted(() => {
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

// 计算当前终端窗格的背景启用状态（支持窗格专属配置或继承全局）
const isTerminalPaneBackgroundActive = computed<boolean>(() => {
  if (props.layoutNode.component !== 'terminal') return false;
  const cfg = props.layoutNode.terminalBackground;
  if (cfg?.mode === 'none') return false;
  if (cfg?.mode === 'custom' && cfg.customImage) return true;
  if (cfg?.mode === 'transparent') return true;
  return isTerminalBackgroundEnabled.value;
});

// 计算当前终端窗格的暗色蒙版不透明度
const terminalPaneOverlayOpacity = computed<number>(() => {
  const cfg = props.layoutNode.terminalBackground;
  if (cfg?.mode === 'custom' && typeof cfg.overlayOpacity === 'number') {
    return cfg.overlayOpacity;
  }
  return currentTerminalBackgroundOverlayOpacity.value;
});

// 计算当前终端窗格的背景图样式 (支持无缝跨屏 fixed 与单个窗格 cover)
const terminalBackgroundImageStyle = computed((): CSSProperties => {
  if (props.layoutNode.component !== 'terminal' || !isTerminalPaneBackgroundActive.value) {
    return {
      backgroundImage: 'none',
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      zIndex: 0,
    };
  }

  const backendUrl = import.meta.env.VITE_API_BASE_URL || '';
  const cfg = props.layoutNode.terminalBackground;
  const rawImagePath = (cfg?.mode === 'custom' && cfg.customImage) 
    ? cfg.customImage 
    : terminalBackgroundImage.value;

  if (!rawImagePath) {
    return {
      backgroundImage: 'none',
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      zIndex: 0,
    };
  }

  const fullImageUrl = rawImagePath.startsWith('http') || rawImagePath.startsWith('data:') 
    ? rawImagePath 
    : `${backendUrl}${rawImagePath}`;

  return {
    backgroundImage: `url(${fullImageUrl})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundAttachment: 'fixed', // 全屏无缝贯穿，多分屏自然拼接整张壁纸
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    zIndex: 0,
  };
});

// --- 动态背景沙箱与生命周期控制器 ---
let cleanupCurrentBackground: (() => void) | null = null;
let backgroundIntersectionObserver: IntersectionObserver | null = null;

const cleanupBackgroundResources = () => {
  if (cleanupCurrentBackground) {
    try {
      cleanupCurrentBackground();
    } catch (err) {
      console.warn('[TerminalCustomHtml] 清理动态背景资源异常:', err);
    }
    cleanupCurrentBackground = null;
  }
  if (backgroundIntersectionObserver) {
    backgroundIntersectionObserver.disconnect();
    backgroundIntersectionObserver = null;
  }
};

// 在终端分屏挂载或动态 HTML 变更时执行内嵌 script
const executeScriptsInElement = (container: HTMLElement) => {
  // 1. 先彻底清理旧背景占用的所有 RAF、定时器和事件监听器
  cleanupBackgroundResources();

  const scripts = Array.from(container.querySelectorAll('script'));
  const paneId = props.layoutNode.id;
  const timerIds = new Set<number>();
  const intervalIds = new Set<number>();
  const rafIds = new Set<number>();
  const eventCleanups: Array<() => void> = [];
  let isPaneVisible = true;

  // 2. 挂载交集观察器（IntersectionObserver）与可见性感知：当分屏折叠或离开视口时自动暂停动画
  backgroundIntersectionObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    isPaneVisible = Boolean(entry && entry.isIntersecting && entry.intersectionRatio > 0.05);
  }, { threshold: [0, 0.05, 0.2] });
  backgroundIntersectionObserver.observe(container);

  // 3. 构建沙箱清理闭包
  cleanupCurrentBackground = () => {
    rafIds.forEach(id => cancelAnimationFrame(id));
    rafIds.clear();
    intervalIds.forEach(id => clearInterval(id));
    intervalIds.clear();
    timerIds.forEach(id => clearTimeout(id));
    timerIds.clear();
    eventCleanups.forEach(fn => fn());
    eventCleanups.length = 0;
  };

  // 4. 将沙箱注入到全局，提供给每个执行脚本使用
  (window as any)[`__pane_sandbox_${paneId}__`] = {
    registerRaf: (id: number) => rafIds.add(id),
    unregisterRaf: (id: number) => rafIds.delete(id),
    registerTimeout: (id: number) => timerIds.add(id),
    unregisterTimeout: (id: number) => timerIds.delete(id),
    registerInterval: (id: number) => intervalIds.add(id),
    unregisterInterval: (id: number) => intervalIds.delete(id),
    registerEventListener: (target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: any) => {
      target.addEventListener(type, listener, options);
      eventCleanups.push(() => target.removeEventListener(type, listener, options));
    },
    isVisible: () => isPaneVisible && (typeof document === 'undefined' || document.visibilityState === 'visible')
  };

  scripts.forEach(oldScript => {
    const newScript = document.createElement('script');
    Array.from(oldScript.attributes).forEach(attr => {
      newScript.setAttribute(attr.name, attr.value);
    });
    if (oldScript.textContent) {
      const originalCode = oldScript.textContent;
      const scopedScript = `
(function(__paneContainer__) {
  if (!__paneContainer__) return;
  var __realDoc = window.document;
  var __sandbox = window['__pane_sandbox_${paneId}__'] || {};

  // 代理 document，约束元素查找在当前分屏容器内
  var document = new Proxy(__realDoc, {
    get: function(target, prop) {
      if (prop === 'getElementById') {
        return function(elementId) {
          return __paneContainer__.querySelector('#' + CSS.escape(elementId)) || target.getElementById(elementId);
        };
      }
      if (prop === 'querySelector') {
        return function(selector) {
          return __paneContainer__.querySelector(selector) || target.querySelector(selector);
        };
      }
      if (prop === 'querySelectorAll') {
        return function(selector) {
          var localElements = __paneContainer__.querySelectorAll(selector);
          return localElements.length > 0 ? localElements : target.querySelectorAll(selector);
        };
      }
      var member = target[prop];
      return typeof member === 'function' ? member.bind(target) : member;
    }
  });

  // 沙箱化 requestAnimationFrame：失焦/不可见自动节流休眠，销毁时自动回收
  var requestAnimationFrame = function(cb) {
    var id = window.requestAnimationFrame(function(time) {
      if (__sandbox.unregisterRaf) __sandbox.unregisterRaf(id);
      if (__sandbox.isVisible && !__sandbox.isVisible()) {
        // 当分屏不可见或页面处于后台时，休眠降频到 1 FPS 探查，避免空转消耗 CPU
        var sleepId = window.setTimeout(function() {
          if (__sandbox.unregisterTimeout) __sandbox.unregisterTimeout(sleepId);
          cb(performance.now());
        }, 1000);
        if (__sandbox.registerTimeout) __sandbox.registerTimeout(sleepId);
        return;
      }
      cb(time);
    });
    if (__sandbox.registerRaf) __sandbox.registerRaf(id);
    return id;
  };

  var cancelAnimationFrame = function(id) {
    if (__sandbox.unregisterRaf) __sandbox.unregisterRaf(id);
    window.cancelAnimationFrame(id);
  };

  var setTimeout = function(cb, delay) {
    var id = window.setTimeout(function() {
      if (__sandbox.unregisterTimeout) __sandbox.unregisterTimeout(id);
      cb();
    }, delay);
    if (__sandbox.registerTimeout) __sandbox.registerTimeout(id);
    return id;
  };

  var clearTimeout = function(id) {
    if (__sandbox.unregisterTimeout) __sandbox.unregisterTimeout(id);
    window.clearTimeout(id);
  };

  var setInterval = function(cb, delay) {
    var id = window.setInterval(cb, delay);
    if (__sandbox.registerInterval) __sandbox.registerInterval(id);
    return id;
  };

  var clearInterval = function(id) {
    if (__sandbox.unregisterInterval) __sandbox.unregisterInterval(id);
    window.clearInterval(id);
  };

  // 代理 window：将 resize 监听同时对接局部 pane-resize，并自动登记清理钩子
  var windowProxy = new Proxy(window, {
    get: function(target, prop) {
      if (prop === 'requestAnimationFrame') return requestAnimationFrame;
      if (prop === 'cancelAnimationFrame') return cancelAnimationFrame;
      if (prop === 'setTimeout') return setTimeout;
      if (prop === 'clearTimeout') return clearTimeout;
      if (prop === 'setInterval') return setInterval;
      if (prop === 'clearInterval') return clearInterval;
      if (prop === 'addEventListener') {
        return function(type, listener, options) {
          if (__sandbox.registerEventListener) {
            __sandbox.registerEventListener(target, type, listener, options);
            if (type === 'resize' && __paneContainer__) {
              __sandbox.registerEventListener(__paneContainer__, 'pane-resize', listener, options);
            }
          } else {
            target.addEventListener(type, listener, options);
          }
        };
      }
      var member = target[prop];
      return typeof member === 'function' ? member.bind(target) : member;
    }
  });

  try {
    ${originalCode}
  } catch (err) {
    console.warn('[TerminalCustomHtml] 执行窗格 ${paneId} 动态脚本异常:', err);
  }
})(document.querySelector('[data-pane-html-container="${paneId}"]'));
`;
      newScript.textContent = scopedScript;
    }
    if (oldScript.parentNode) {
      oldScript.parentNode.replaceChild(newScript, oldScript);
    } else {
      container.appendChild(newScript);
    }
  });
};

// 监听动态 HTML 内容变化并在 DOM 就绪后重新执行
watch(terminalCustomHTML, (newHtmlContent, oldHtmlContent) => {
  if (props.layoutNode.component !== 'terminal') return;

  if (newHtmlContent === oldHtmlContent && oldHtmlContent !== undefined) {
    return;
  }
  nextTick(() => {
    const container = customHtmlLayerRef.value;
    if (container && newHtmlContent && isTerminalPaneBackgroundActive.value) {
      executeScriptsInElement(container);
    } else {
      cleanupBackgroundResources();
    }
  });
}, { immediate: true });

onBeforeUnmount(() => {
  cleanupBackgroundResources();
  unsubscribeFromWorkspaceEvent('terminal:stabilizedResize', handleStabilizedTerminalResize);
});

</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden">
    <!-- Left Sidebar Buttons -->
    <div class="flex flex-col bg-sidebar py-1 z-10 flex-shrink-0 border-r border-border" v-if="isRootRenderer && visibleLeftSidebarPanes.length > 0">
        <button
            v-for="pane in visibleLeftSidebarPanes"
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
                        :recent-connections-pane-id="recentPanelPaneId"
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
                        class="terminal-pane-container relative flex-grow overflow-hidden transition-colors duration-200"
                        :class="[
                            { 'has-global-terminal-background': isTerminalPaneBackgroundActive, 'bg-background': !isTerminalPaneBackgroundActive }
                        ]"
                        @mousedown="layoutStore.setActiveTerminalPaneId(layoutNode.id)"
                    >
                        <!-- 终端聚焦顶部指示线 (仅多终端分屏且当前处于聚焦态时显示，单终端时不显示) -->
                        <div
                            class="terminal-focus-top-line absolute top-0 left-0 right-0 pointer-events-none transition-opacity duration-150"
                            :class="[
                                (isCurrentTerminalFocused && isMultiTerminalPanes) ? 'opacity-100' : 'opacity-0'
                            ]"
                            style="z-index: 20;"
                        ></div>
                       <!-- Shared Background Layers (窗格专属或全局多终端背景) -->
                       <div
                           v-if="isTerminalPaneBackgroundActive"
                           class="shared-terminal-background-layers"
                           style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0;"
                       >
                           <!-- Background Image (支持跨分屏无缝连续固定背景) -->
                           <div
                               class="terminal-background-image-layer"
                               :style="terminalBackgroundImageStyle"
                           ></div>
                           <!-- Color Overlay -->
                           <div
                               class="terminal-background-overlay-layer"
                               :style="{
                                   position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
                                   backgroundColor: `rgba(0, 0, 0, ${terminalPaneOverlayOpacity})`,
                                   zIndex: 1, pointerEvents: 'none'
                               }"
                           ></div>
                           <!-- Custom HTML (带当前分屏作用域标记与独立沙箱) -->
                           <div
                               ref="customHtmlLayerRef"
                               v-if="terminalCustomHTML && isTerminalPaneBackgroundActive"
                               :data-pane-html-container="layoutNode.id"
                               class="terminal-custom-html-layer"
                               style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; overflow: hidden;"
                               v-html="terminalCustomHTML"
                           ></div>
                       </div>

                       <!-- Terminal Instances -->
                       <!--
                         这里只渲染"本 LayoutRenderer 所属会话"的终端。
                         历史实现是对 sessionStore.sessions 再做一层 v-for，
                         那是"全局唯一渲染器"时代的写法：后来 DesktopWorkspaceView
                         改成每个会话一个 LayoutRenderer + v-show，内层循环就变成了 N×N，
                         并且每个会话的 Terminal 会被注册进"所有"会话的 terminalPanes，
                         导致 pane 串味、primary 指向错误分屏、命令发到别的会话。
                         保活由外层 LayoutRenderer 的 v-show 负责，无需内层循环。
                       -->
                       <template v-if="activeSessionId && sessionStore.sessions.get(activeSessionId)?.kind === 'ssh'">
                           <keep-alive>
                               <component
                                   :is="componentMap.terminal"
                                   :key="`${activeSessionId}-${layoutNode.id}`"
                                   :session-id="activeSessionId"
                                   :pane-id="layoutNode.id"
                                    :auto-exec-config="layoutNode.terminalAutoExec"
                                    :is-active="true"
                                    :is-pane-focused="layoutStore.activeTerminalPaneId === layoutNode.id"
                                    @focus="layoutStore.setActiveTerminalPaneId(layoutNode.id)"
                                   :class="['terminal-instance-wrapper absolute inset-0 w-full h-full', { 'terminal-transparent': isTerminalPaneBackgroundActive }]"
                                   :style="{ zIndex: 3 }"
                                   :options="{}"
                               />
                           </keep-alive>
                       </template>

                       <!-- 没有任何会话时：这个终端面板直接列最近连接，点一下就能开 -->
                       <RecentConnectionsPanel
                           v-if="showRecentConnections"
                           class="absolute inset-0"
                           :style="{ zIndex: 4 }"
                       />
                       <!-- 其它情况（只有远程桌面会话、或选的不是第一个终端面板）仍给占位提示 -->
                       <div v-else-if="!activeSessionId || !hasSshSessions"
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
                  <!-- FileManager (支持多会话并行常驻渲染，切走时后台不间断初始化) -->
                  <template v-else-if="layoutNode.component === 'fileManager'">
                    <div class="relative w-full h-full flex flex-col min-h-0 overflow-hidden">
                      <template v-for="[sessionId, sessionState] in sshSessions" :key="sessionId">
                        <component
                          :is="componentMap.fileManager"
                          v-show="sessionId === effectiveFileManagerSessionId"
                          :session-id="sessionId"
                          :owner-session-id="props.activeSessionId"
                          :is-foreground="sessionId === effectiveFileManagerSessionId"
                          :instance-id="mainPaneInstanceId"
                          :db-connection-id="String(sessionState.connectionId)"
                          :ws-deps="{
                            sendMessage: sessionState.wsManager.sendMessage,
                            onMessage: sessionState.wsManager.onMessage,
                            isConnected: sessionState.wsManager.isConnected,
                            isSftpReady: sessionState.wsManager.isSftpReady
                          }"
                          class="flex-grow min-h-0 overflow-auto"
                        />
                      </template>
                      <div v-if="!effectiveFileManagerSessionId || sshSessions.length === 0" class="flex-grow flex justify-center items-center text-center text-text-secondary bg-header text-sm p-4">
                        <div class="flex flex-col items-center justify-center p-8 w-full h-full">
                          <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                          <span class="text-lg font-medium text-text-secondary mb-2">{{ t('layout.noActiveSession.title') }}</span>
                          <div class="text-xs text-text-secondary mt-2">{{ t('layout.noActiveSession.message') }}</div>
                        </div>
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
                <!-- 侧边栏如果激活了 fileManager，多会话并行常驻 -->
                <template v-if="activeLeftSidebarPane === 'fileManager'">
                  <div class="relative w-full h-full flex flex-col min-h-0 overflow-hidden">
                    <template v-for="[sessionId, sessionState] in sshSessions" :key="sessionId">
                      <component
                        :is="componentMap.fileManager"
                        v-show="sessionId === sidebarFileManagerSessionId.left"
                        :session-id="sessionId"
                        :owner-session-id="props.activeSessionId"
                        :is-foreground="sessionId === sidebarFileManagerSessionId.left"
                        instance-id="sidebar-left"
                        :db-connection-id="String(sessionState.connectionId)"
                        :ws-deps="{
                          sendMessage: sessionState.wsManager.sendMessage,
                          onMessage: sessionState.wsManager.onMessage,
                          isConnected: sessionState.wsManager.isConnected,
                          isSftpReady: sessionState.wsManager.isSftpReady
                        }"
                        class="flex flex-col flex-grow min-h-0 overflow-auto"
                      />
                    </template>
                    <div v-if="!sidebarFileManagerSessionId.left || sshSessions.length === 0" class="flex flex-col flex-grow justify-center items-center text-center text-text-secondary p-4">
                      <div class="flex flex-col items-center justify-center p-8">
                        <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                        <span class="text-lg font-medium mb-2">{{ t('layout.noActiveSession.title') }}</span>
                        <div class="text-xs mt-2">{{ t('layout.noActiveSession.fileManagerSidebar') }}</div>
                      </div>
                    </div>
                  </div>
                </template>
                <component
                  v-else-if="currentLeftSidebarComponent && activeLeftSidebarPane && (!isSessionDependentSidebarPane(activeLeftSidebarPane) || activeSession)"
                  :is="currentLeftSidebarComponent"
                  :key="`left-comp-${activeLeftSidebarPane}`"
                  v-bind="sidebarProps(activeLeftSidebarPane, 'left')"
                  class="flex flex-col flex-grow"
                />
                <div v-else-if="activeLeftSidebarPane" class="flex flex-col flex-grow justify-center items-center text-center text-text-secondary p-4">
                  <div class="flex flex-col items-center justify-center p-8">
                    <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                    <span class="text-lg font-medium mb-2">{{ t('layout.noActiveSession.title') }}</span>
                    <div class="text-xs mt-2">{{ t('layout.noActiveSession.fileManagerSidebar') }}</div>
                  </div>
                </div>
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
                <!-- 侧边栏如果激活了 fileManager，多会话并行常驻 -->
                <template v-if="activeRightSidebarPane === 'fileManager'">
                  <div class="relative w-full h-full flex flex-col min-h-0 overflow-hidden">
                    <template v-for="[sessionId, sessionState] in sshSessions" :key="sessionId">
                      <component
                        :is="componentMap.fileManager"
                        v-show="sessionId === sidebarFileManagerSessionId.right"
                        :session-id="sessionId"
                        :owner-session-id="props.activeSessionId"
                        :is-foreground="sessionId === sidebarFileManagerSessionId.right"
                        instance-id="sidebar-right"
                        :db-connection-id="String(sessionState.connectionId)"
                        :ws-deps="{
                          sendMessage: sessionState.wsManager.sendMessage,
                          onMessage: sessionState.wsManager.onMessage,
                          isConnected: sessionState.wsManager.isConnected,
                          isSftpReady: sessionState.wsManager.isSftpReady
                        }"
                        class="flex flex-col flex-grow min-h-0 overflow-auto"
                      />
                    </template>
                    <div v-if="!sidebarFileManagerSessionId.right || sshSessions.length === 0" class="flex flex-col flex-grow justify-center items-center text-center text-text-secondary p-4">
                      <div class="flex flex-col items-center justify-center p-8">
                        <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                        <span class="text-lg font-medium mb-2">{{ t('layout.noActiveSession.title') }}</span>
                        <div class="text-xs mt-2">{{ t('layout.noActiveSession.fileManagerSidebar') }}</div>
                      </div>
                    </div>
                  </div>
                </template>
                <component
                  v-else-if="currentRightSidebarComponent && activeRightSidebarPane && (!isSessionDependentSidebarPane(activeRightSidebarPane) || activeSession)"
                  :is="currentRightSidebarComponent"
                  :key="`right-comp-${activeRightSidebarPane}`"
                  v-bind="sidebarProps(activeRightSidebarPane, 'right')"
                  class="flex flex-col flex-grow"
                />
                <div v-else-if="activeRightSidebarPane" class="flex flex-col flex-grow justify-center items-center text-center text-text-secondary p-4">
                  <div class="flex flex-col items-center justify-center p-8">
                    <i class="fas fa-plug text-4xl mb-3 text-text-secondary"></i>
                    <span class="text-lg font-medium mb-2">{{ t('layout.noActiveSession.title') }}</span>
                    <div class="text-xs mt-2">{{ t('layout.noActiveSession.fileManagerSidebar') }}</div>
                  </div>
                </div>
                <div v-else class="flex flex-col flex-grow">
                </div>
            </div>
        </KeepAlive>
    </div>

     <!-- Right Sidebar Buttons -->
    <div class="flex flex-col bg-sidebar py-1 z-10 flex-shrink-0 border-l border-border" v-if="isRootRenderer && visibleRightSidebarPanes.length > 0">
         <button
             v-for="pane in visibleRightSidebarPanes"
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

/* --- 关闭 splitpanes 自带的 pane 尺寸过渡 --- */
/*
 * splitpanes.css 里有一条 `.splitpanes--ready .splitpanes__pane { transition: width .2s, height .2s }`，
 * 一旦 panes 就绪，任何宽度/高度变化（刷新恢复布局、切会话、快照回填比例）都会走 200ms 动画，
 * 表现为"终端从左往右拉开"；而终端背景层是 `background-attachment: fixed` + 100%×100%，
 * 按容器盒子裁剪 → 动画期间只露出左边一部分，看起来就是"背景样式只加载了一半"。
 *
 * 拖动分割条时 splitpanes 本来就会加 .splitpanes--dragging 临时关掉过渡，
 * 所以这里直接全局禁用，尺寸变化一律即时生效。
 */
.splitpanes--ready .splitpanes__pane {
  transition: none;
  will-change: auto;
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

/* 注意：.xterm / .xterm-viewport / .xterm-screen 是子组件（Terminal.vue）内部的元素，
   scoped 样式默认匹配不到，必须用 :deep()，否则这几条透明规则从来没生效过
   —— 表现就是"清屏/退出 TUI 后整块区域变成不透明的黑，背景图被盖住"。 */
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent,
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent .terminal-scroll-viewport,
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent .terminal-inner-container,
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent :deep(.xterm),
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent :deep(.xterm-viewport),
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent :deep(.xterm-screen),
.terminal-pane-container.has-global-terminal-background .terminal-outer-wrapper.terminal-transparent :deep(.xterm-rows) {
  background-color: transparent !important;
}

.terminal-custom-html-layer {
  width: 100% !important;
  height: 100% !important;
  overflow: hidden !important;
  pointer-events: none !important;
}

/* 终端聚焦顶部指示线：仅顶部高亮，置于 z-index: 20，继承系统界面主题色 var(--link-active-color) */
.terminal-focus-top-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2.5px;
  pointer-events: none;
  z-index: 20;
  background-color: var(--link-active-color);
  box-shadow: 0 1px 8px color-mix(in srgb, var(--link-active-color) 45%, transparent);
  transition: opacity 0.15s ease-in-out;
}

</style>

