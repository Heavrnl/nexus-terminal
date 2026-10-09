<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch, watchEffect, type PropType, readonly, defineExpose, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { createSftpActionsManager, type WebSocketDependencies } from '../composables/useSftpActions';
import { useFileUploader } from '../composables/useFileUploader';
import { useFileEditorStore, type FileInfo } from '../stores/fileEditor.store';
import { useSessionStore } from '../stores/session.store';
import { useSettingsStore } from '../stores/settings.store';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useFileManagerContextMenu, type ClipboardState, type CompressFormat } from '../composables/file-manager/useFileManagerContextMenu';
import { useFileManagerSelection } from '../composables/file-manager/useFileManagerSelection';
import { useFileManagerDragAndDrop } from '../composables/file-manager/useFileManagerDragAndDrop';
import { useFileManagerKeyboardNavigation } from '../composables/file-manager/useFileManagerKeyboardNavigation';
import { useFileManagerVirtualScroll } from '../composables/file-manager/useFileManagerVirtualScroll';
import { useFileManagerColumnResize } from '../composables/file-manager/useFileManagerColumnResize';
import { useFileManagerOperations } from '../composables/file-manager/useFileManagerOperations';
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import FileUploadPopup from './FileUploadPopup.vue';
import FileManagerContextMenu from './FileManagerContextMenu.vue';
import FileManagerActionModal from './FileManagerActionModal.vue';
import FileManagerHeader from './FileManagerHeader.vue';
import FileManagerBreadcrumbs from './FileManagerBreadcrumbs.vue';
import DirectoryTree from './DirectoryTree.vue';
import MobileFileManagerList from './MobileFileManagerList.vue';
import MobileFileActionSheet from './MobileFileActionSheet.vue';
import type { FileListItem } from '../types/sftp.types';
import type { WebSocketMessage } from '../types/websocket.types';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { getFileIconClass } from '../utils/fileIcons';
import { formatFileSize, formatFileMode, formatFileDate } from '../utils/fileFormatters';
import { useComponentStateStore } from '../stores/componentState.store';
import { useLayoutStore } from '../stores/layout.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import {
  useFileManagerColumnReorder,
  COLUMN_CONFIG_MAP,
  type FileManagerColumnKey,
} from '../composables/file-manager/useFileManagerColumnReorder';

type SftpManagerInstance = ReturnType<typeof createSftpActionsManager>;


// --- Props ---
const props = defineProps({
  sessionId: {
    type: String,
    required: true,
  },
  // 文件管理器实例 ID
  instanceId: {
    type: String,
    required: true,
  },
  // 注入数据库连接 ID
  dbConnectionId: {
    type: String,
    required: true,
  },
  // 注入此组件及其子 composables 所需的 WebSocket 依赖项
  wsDeps: {
    type: Object as PropType<WebSocketDependencies>,
    required: true,
  },
  isMobile: {
    type: Boolean,
    default: false
  }
});

// --- 核心 Composables ---
const { t } = useI18n();
const route = useRoute(); // Keep for download URL generation for now
const sessionStore = useSessionStore(); // 实例化 Session Store

// --- 获取并存储 SFTP 管理器实例 ---
// 使用 shallowRef 存储管理器实例，以便在 sessionId 变化时切换
const currentSftpManager = shallowRef<SftpManagerInstance | null>(null);

const initializeSftpManager = (sessionId: string, instanceId: string) => {
    const manager = sessionStore.getOrCreateSftpManager(sessionId, instanceId);
    if (!manager) {
        // 抛出错误或显示错误消息，阻止组件进一步渲染
        console.error(`[FileManager ${sessionId}-${instanceId}] Failed to get or create SFTP manager instance.`);
        // 可以设置一个错误状态 ref 在模板中显示
        // managerError.value = `Failed to get SFTP manager for instance ${instanceId}`;
        currentSftpManager.value = null; // 确保设置为 null
        // 抛出错误会阻止组件渲染，可能不是最佳用户体验
        // throw new Error(`[FileManager ${sessionId}-${instanceId}] Failed to get or create SFTP manager instance.`);
    } else {
         currentSftpManager.value = manager;
         console.log(`[FileManager ${sessionId}-${instanceId}] SFTP Manager initialized/retrieved.`);
    }
};

// 初始加载管理器
initializeSftpManager(props.sessionId, props.instanceId);


// --- 文件上传模块 ---
// 修改：依赖 currentSftpManager 的状态
const {
    uploads,
    startFileUpload,
    cancelUpload,
} = useFileUploader(
    computed(() => props.sessionId),
    // 传递 manager 的 currentPath 和 fileList ref
    computed(() => currentSftpManager.value?.currentPath.value ?? '/'),
    computed(() => currentSftpManager.value?.fileList.value ?? []),
    computed(() => props.wsDeps)
);

// 实例化其他 Stores
const fileEditorStore = useFileEditorStore(); // 实例化 File Editor Store
const settingsStore = useSettingsStore(); // 实例化 Settings Store
const focusSwitcherStore = useFocusSwitcherStore(); // 实例化焦点切换 Store
const uiNotificationsStore = useUiNotificationsStore(); // 实例化通知 store
const workspaceSyncStore = useWorkspaceSyncStore(); // 实例化工作区同步 store
 
// 从 Settings Store 获取共享设置
const {
  shareFileEditorTabsBoolean,
  fileManagerRowSizeMultiplierNumber,
  fileManagerColWidthsObject,
  showPopupFileEditorBoolean,
  fileManagerShowDeleteConfirmationBoolean,
  fileManagerDoubleClickToOpenBoolean,
} = storeToRefs(settingsStore);

// --- 统一组件实例标识 (跨会话联动核心，避免跟随单独会话隔离) ---
const effectiveInstanceId = computed(() => props.instanceId || 'default');
const emitWorkspaceEvent = useWorkspaceEventEmitter();

// --- 纯目录树导航窗格状态 (按组件实例统一存储与跨会话联动) ---
const LS_SHOW_DIRECTORY_TREE_KEY = 'file_manager_show_directory_tree';
const LS_DIRECTORY_TREE_WIDTH_KEY = 'file_manager_directory_tree_width';

const getInitialDirectoryTreeVisible = (instId: string): boolean => {
  if (typeof localStorage === 'undefined') return false;
  const specific = localStorage.getItem(`${LS_SHOW_DIRECTORY_TREE_KEY}:${instId}`);
  if (specific !== null) return specific === 'true';
  return localStorage.getItem(LS_SHOW_DIRECTORY_TREE_KEY) === 'true';
};

const getInitialDirectoryTreeWidth = (instId: string): number => {
  if (typeof localStorage === 'undefined') return 220;
  const specific = localStorage.getItem(`${LS_DIRECTORY_TREE_WIDTH_KEY}:${instId}`);
  if (specific !== null) return parseInt(specific, 10) || 220;
  return parseInt(localStorage.getItem(LS_DIRECTORY_TREE_WIDTH_KEY) || '220', 10) || 220;
};

const showDirectoryTree = ref<boolean>(getInitialDirectoryTreeVisible(effectiveInstanceId.value));
const directoryTreeWidth = ref<number>(getInitialDirectoryTreeWidth(effectiveInstanceId.value));

const isResizingTree = ref(false);

const toggleDirectoryTree = () => {
  const nextVal = !showDirectoryTree.value;
  showDirectoryTree.value = nextVal;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`${LS_SHOW_DIRECTORY_TREE_KEY}:${effectiveInstanceId.value}`, String(nextVal));
    localStorage.setItem(LS_SHOW_DIRECTORY_TREE_KEY, String(nextVal));
  }
  emitWorkspaceEvent('fileManager:setDirectoryTreeVisible', {
    instanceId: effectiveInstanceId.value,
    show: nextVal,
  });
};

// --- 平铺与列表视图状态 (跟随唯一组件实例隔离 + 分端 + 跨会话广播联动) ---
const { isMobile: isMobileDevice } = useDeviceDetection();
const isMobileComputed = computed(() => props.isMobile || isMobileDevice.value || (typeof window !== 'undefined' && window.innerWidth < 768));
const platform = computed<'mobile' | 'desktop'>(() => isMobileComputed.value ? 'mobile' : 'desktop');

const componentStateStore = useComponentStateStore();
const layoutStore = useLayoutStore();

const viewModeStorageKey = computed(() => `fm_view_mode:${platform.value}:${effectiveInstanceId.value}`);

const viewMode = ref<'list' | 'tile'>(
  componentStateStore.getState<'list' | 'tile'>(viewModeStorageKey.value, 'list')
);

watch(viewModeStorageKey, (newKey) => {
  viewMode.value = componentStateStore.getState<'list' | 'tile'>(newKey, 'list');
});

watch(() => componentStateStore.isLoaded, () => {
  viewMode.value = componentStateStore.getState<'list' | 'tile'>(viewModeStorageKey.value, viewMode.value);
});

const toggleViewMode = () => {
  const nextMode = viewMode.value === 'list' ? 'tile' : 'list';
  viewMode.value = nextMode;
  componentStateStore.setState(viewModeStorageKey.value, nextMode);
  emitWorkspaceEvent('fileManager:setViewMode', {
    instanceId: effectiveInstanceId.value,
    viewMode: nextMode,
  });
};

// 预定义返回上级目录虚拟项目
const parentDirectoryItem: FileListItem = {
  filename: '..',
  longname: '..',
  attrs: {
    isDirectory: true,
    isFile: false,
    isSymbolicLink: false,
    size: 0,
    uid: 0,
    gid: 0,
    mode: 0,
    atime: 0,
    mtime: 0,
  },
};

const handleTreeSelectDirectory = (path: string) => {
  if (currentSftpManager.value) {
    currentSftpManager.value.loadDirectory(path);
  }
};

const handleTreeSelectFile = (filePath: string, fileName: string) => {
  const fileInfo: FileInfo = { name: fileName, fullPath: filePath };

  if (settingsStore.showPopupFileEditorBoolean) {
    fileEditorStore.triggerPopup(filePath, props.sessionId);
  }

  if (shareFileEditorTabsBoolean.value) {
    fileEditorStore.openFile(filePath, props.sessionId, props.instanceId);
  } else {
    sessionStore.openFileInSession(props.sessionId, fileInfo);
  }

  // 同步右侧表格定位到该文件的父目录并高亮此文件
  const lastSlash = filePath.lastIndexOf('/');
  const parentDir = lastSlash <= 0 ? '/' : filePath.substring(0, lastSlash);
  if (currentSftpManager.value) {
    if (currentSftpManager.value.currentPath.value !== parentDir) {
      currentSftpManager.value.loadDirectory(parentDir);
    }
    selectedItems.value.clear();
    selectedItems.value.add(fileName);
  }
};

const startTreeResize = (e: MouseEvent) => {
  e.preventDefault();
  isResizingTree.value = true;
  const startX = e.clientX;
  const startWidth = directoryTreeWidth.value;

  const onMouseMove = (moveEvent: MouseEvent) => {
    if (!isResizingTree.value) return;
    const delta = moveEvent.clientX - startX;
    const newWidth = Math.max(140, Math.min(480, startWidth + delta));
    directoryTreeWidth.value = newWidth;
  };

  const onMouseUp = () => {
    isResizingTree.value = false;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${LS_DIRECTORY_TREE_WIDTH_KEY}:${effectiveInstanceId.value}`, String(directoryTreeWidth.value));
      localStorage.setItem(LS_DIRECTORY_TREE_WIDTH_KEY, String(directoryTreeWidth.value));
    }
    emitWorkspaceEvent('fileManager:setDirectoryTreeWidth', {
      instanceId: effectiveInstanceId.value,
      width: directoryTreeWidth.value,
    });
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
};

// --- UI 状态 Refs ---
const headerRef = ref<InstanceType<typeof FileManagerHeader> | null>(null);
const breadcrumbsRef = ref<InstanceType<typeof FileManagerBreadcrumbs> | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const sortKey = ref<keyof FileListItem | 'type' | 'size' | 'mtime'>('filename');
const sortDirection = ref<'asc' | 'desc'>('asc');
const searchQuery = ref(''); // 搜索查询 ref (与 Header 双向绑定)
const isMultiSelectMode = ref(false); // 多选模式状态 (主要用于移动端)
const isSearchActive = ref(false); // 控制搜索框激活状态 (与 Header 双向绑定)
const fileListContainerRef = ref<HTMLDivElement | null>(null); // 文件列表容器引用
const dropOverlayRef = ref<HTMLDivElement | null>(null); // 拖拽蒙版引用

const rowSizeMultiplier = ref(1.0); // 行大小乘数, 默认值会被 store 覆盖
const tableRef = ref<HTMLTableElement | null>(null);
const tableHeaderContainerRef = ref<HTMLDivElement | null>(null);

// 滚动位置管理与防干扰标记
const isRestoringScroll = ref(false);
const hasRestoredInitialScroll = ref(false);
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;

// 表格内容滚动时同步表头的横向滚动偏移与云端工作区 (防抖记录，必须在初次恢复成功后才允许写回，杜绝任何过渡期 0 值误覆)
const handleBodyScroll = (e: Event) => {
  const target = e.target as HTMLElement;
  if (tableHeaderContainerRef.value && target) {
    tableHeaderContainerRef.value.scrollLeft = target.scrollLeft;
  }
  // 核心守卫：必须在非程序化还原期间允许向 store 写回
  if (target && !isRestoringScroll.value) {
    // 若用户主动交互滚动（e.isTrusted），直接解除初始还原守卫，确保主动滚动立即生效
    if (!hasRestoredInitialScroll.value && e.isTrusted) {
      hasRestoredInitialScroll.value = true;
    }
    if (hasRestoredInitialScroll.value) {
      const currentScrollTop = target.scrollTop;
      const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
      let currentRatio = maxScroll > 0 ? (currentScrollTop / maxScroll) : 0;
      // 边界智能吸附：距底部 6px 以内吸附至 1.0，距顶部 3px 以内吸附至 0.0
      if (maxScroll > 0 && currentScrollTop >= maxScroll - 6) {
        currentRatio = 1.0;
      } else if (currentScrollTop <= 3) {
        currentRatio = 0.0;
      }
      currentRatio = Math.max(0, Math.min(1, Number(currentRatio.toFixed(4))));

      if (scrollSaveTimer) {
        clearTimeout(scrollSaveTimer);
      }
      scrollSaveTimer = setTimeout(() => {
        // 只有在非程序化还原中，且当前文件管理器容器在页面上真实可见（非后台 display:none 误触发 0）时，才同步更新 store
        const isVisible = fileListContainerRef.value && (fileListContainerRef.value.offsetParent !== null || props.isMobile);
        if (!isRestoringScroll.value && hasRestoredInitialScroll.value && isVisible) {
          workspaceSyncStore.updateFileManagerInstanceState(props.sessionId, props.instanceId, {
            scrollTop: currentScrollTop,
            scrollRatio: currentRatio,
          });
        }
      }, 150);
    }
  }
};

// 监听搜索状态与查询词，实时同步到云端工作区
watch([isSearchActive, searchQuery], ([active, query]) => {
  workspaceSyncStore.updateFileManagerInstanceState(props.sessionId, props.instanceId, {
    isSearchActive: active,
    searchQuery: query,
  });
});

// 监听当前路径变更，实时同步到云端工作区（仅同步有效绝对路径，杜绝相对路径占位）
watch(() => currentSftpManager.value?.currentPath.value, (newPath) => {
  if (newPath && newPath.trim().startsWith('/')) {
    workspaceSyncStore.updateFileManagerInstanceState(props.sessionId, props.instanceId, { currentPath: newPath });
  }
}, { immediate: true });

// --- 列宽调整 Composable ---
const {
  colWidths,
  isResizing,
  resizingColumnIndex,
  startResize,
} = useFileManagerColumnResize(undefined, () => {
  saveLayoutSettings();
});

// --- 辅助函数 ---
const generateRequestId = (): string => `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

// --- 排序与过滤逻辑 ---
// 修改：依赖 currentSftpManager.value.fileList
const sortedFileList = computed(() => {
    if (!currentSftpManager.value?.fileList.value) return []; // 检查 manager 和 fileList 是否存在
    const list = [...currentSftpManager.value.fileList.value]; // 从 manager 获取列表
    const key = sortKey.value;
    const direction = sortDirection.value === 'asc' ? 1 : -1;

    list.sort((a, b) => {
        if (key !== 'type') {
            if (a.attrs.isDirectory && !b.attrs.isDirectory) return -1;
            if (!a.attrs.isDirectory && b.attrs.isDirectory) return 1;
        }
        let valA: string | number | boolean;
        let valB: string | number | boolean;
        switch (key) {
            case 'type':
                valA = a.attrs.isDirectory ? 0 : (a.attrs.isSymbolicLink ? 1 : 2);
                valB = b.attrs.isDirectory ? 0 : (b.attrs.isSymbolicLink ? 1 : 2);
                break;
            case 'filename': valA = a.filename.toLowerCase(); valB = b.filename.toLowerCase(); break;
            case 'size': valA = a.attrs.isFile ? a.attrs.size : -1; valB = b.attrs.isFile ? b.attrs.size : -1; break;
            case 'mtime': valA = a.attrs.mtime; valB = b.attrs.mtime; break;
            default: valA = a.filename.toLowerCase(); valB = b.filename.toLowerCase();
        }
        if (valA < valB) return -1 * direction;
        if (valA > valB) return 1 * direction;
        if (key !== 'filename') return a.filename.localeCompare(b.filename);
        return 0;
    });
    return list;
});

const filteredFileList = computed(() => {
    if (!searchQuery.value) {
        return sortedFileList.value; // 如果没有搜索查询，返回原始排序列表
    }
    const lowerCaseQuery = searchQuery.value.toLowerCase();
    return sortedFileList.value.filter(item =>
        item.filename.toLowerCase().includes(lowerCaseQuery)
    );
});

const handleSort = (key: keyof FileListItem | 'type' | 'size' | 'mtime') => {
    if (sortKey.value === key) {
        sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
    } else {
        sortKey.value = key;
        sortDirection.value = 'asc';
    }
};

// --- 表头列顺序及长按拖拽重排 ---
const {
  columnOrder,
  isDraggingColumn,
  dragSourceCol,
  dragOverCol,
  dropPosition,
  dragMouseX,
  dragMouseY,
  handleHeaderPointerDown,
} = useFileManagerColumnReorder({
  instanceId: props.instanceId,
  componentStateStore,
  isResizing,
  onSort: (key) => handleSort(key),
});


// --- 桌面端行级加载与导航反馈状态 ---
// 正在导航进入的目标条目名称（如 '..' 或具体文件夹名称）
const navigatingTargetName = ref<string | null>(null);

// 监听路径变动：清空当前条目导航状态
watch(
  () => currentSftpManager.value?.currentPath.value,
  () => {
    navigatingTargetName.value = null;
  }
);

// 监听全局加载状态变动：加载完成后清空导航状态
watch(
  () => currentSftpManager.value?.isLoading.value,
  (loading) => {
    if (!loading) {
      navigatingTargetName.value = null;
    }
  }
);

// --- 列表项点击与选择逻辑 (使用 Composable) ---
// 定义单击时的动作回调 (移到 Selection 实例化之前)
const handleItemAction = (item: FileListItem) => {
  if (!currentSftpManager.value) return;

  const itemPath = currentSftpManager.value.joinPath(currentSftpManager.value.currentPath.value, item.filename);

  if (item.attrs.isSymbolicLink) {
    if (currentSftpManager.value.isLoading.value) {
      return;
    }
    console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Symbolic link clicked: ${itemPath}. Attempting to resolve with sftp:realpath...`);

    const { sendMessage: wsSend, onMessage: wsOnMessage } = props.wsDeps;
    const requestId = generateRequestId();

    const handleResolvedPath = (realPath: string, targetType: 'file' | 'directory' | 'unknown', originalLinkItem: FileListItem) => {
      if (!currentSftpManager.value) return;


      if (targetType === 'directory') {
        navigatingTargetName.value = originalLinkItem.filename;
        currentSftpManager.value.loadDirectory(realPath);
      } else if (targetType === 'file') {
        const targetFilename = realPath.substring(realPath.lastIndexOf('/') + 1) || originalLinkItem.filename; // Get filename from realPath
        const fileInfo: FileInfo = { name: targetFilename, fullPath: realPath };

        // Preserve mobile multi-select behavior for the original link item
        if (props.isMobile && isMultiSelectMode.value) {
          if (selectedItems.value.has(originalLinkItem.filename)) {
            selectedItems.value.delete(originalLinkItem.filename);
          } else {
            selectedItems.value.add(originalLinkItem.filename);
          }
          return;
        }

        if (settingsStore.showPopupFileEditorBoolean) {
          fileEditorStore.triggerPopup(realPath, props.sessionId);
        }
        if (shareFileEditorTabsBoolean.value) {
          fileEditorStore.openFile(realPath, props.sessionId, props.instanceId);
        } else {
          sessionStore.openFileInSession(props.sessionId, fileInfo);
        }
      } else { // targetType is 'unknown' or not provided as expected
        console.warn(`[FileManager ${props.sessionId}-${props.instanceId}] Symlink target '${realPath}' has an unknown type from server ('${targetType}'). Defaulting to open as file.`);
        // Fallback: attempt to open as file, or display an error
        const targetFilename = realPath.substring(realPath.lastIndexOf('/') + 1) || originalLinkItem.filename;
        const fileInfo: FileInfo = { name: targetFilename, fullPath: realPath };
        if (settingsStore.showPopupFileEditorBoolean) {
          fileEditorStore.triggerPopup(realPath, props.sessionId);
        }
        if (shareFileEditorTabsBoolean.value) {
          fileEditorStore.openFile(realPath, props.sessionId, props.instanceId);
        } else {
          sessionStore.openFileInSession(props.sessionId, fileInfo);
        }
      }
    };

    let unregisterSuccess: (() => void) | undefined;
    let unregisterError: (() => void) | undefined;
    let timeoutId: NodeJS.Timeout | number | undefined;

    const cleanupListeners = () => {
      unregisterSuccess?.();
      unregisterError?.();
      if (timeoutId) clearTimeout(timeoutId as any);
      timeoutId = undefined;
    };

    unregisterSuccess = wsOnMessage('sftp:realpath:success', (payload: any, message: WebSocketMessage) => {
      if (message.requestId === requestId && payload.requestedPath === itemPath) {
        cleanupListeners();
        if (!currentSftpManager.value) return;
        // 从 payload 中获取 absolutePath 和 targetType
        const absolutePath = payload.absolutePath;
        const targetType = payload.targetType as ('file' | 'directory' | 'unknown'); // 类型断言

        if (!absolutePath) {
            console.error(`[FileManager ${props.sessionId}-${props.instanceId}] sftp:realpath:success for ${itemPath} missing absolutePath. Payload:`, payload);
            return;
        }
         if (!targetType) {
            console.warn(`[FileManager ${props.sessionId}-${props.instanceId}] sftp:realpath:success for ${itemPath} missing targetType. Defaulting to 'file'. Payload:`, payload);
        }

        handleResolvedPath(absolutePath, targetType || 'unknown', item);
      }
    });

    unregisterError = wsOnMessage('sftp:realpath:error', (payload: any, message: WebSocketMessage) => {
      if (message.requestId === requestId && payload?.requestedPath === itemPath) {
        cleanupListeners();
        // payload.error 可能包含来自后端的具体错误信息
        // payload.absolutePath 可能在 stat 失败时仍然存在
        const serverErrorMsg = payload.error || 'Unknown error resolving symlink target type';
        const resolvedPathInfo = payload.absolutePath ? ` (Resolved path: ${payload.absolutePath})` : '';

        console.error(`[FileManager ${props.sessionId}-${props.instanceId}] Failed to get realpath or target type for symlink '${itemPath}': ${serverErrorMsg}${resolvedPathInfo}`);
      }
    });

    timeoutId = setTimeout(() => {
      cleanupListeners();
      console.error(`[FileManager ${props.sessionId}-${props.instanceId}] Timeout getting realpath for symlink '${itemPath}' (ID: ${requestId}).`);
    }, 10000); // 10 秒超时
    wsSend({ type: 'sftp:realpath', requestId: requestId, payload: { path: itemPath } });
    return; // Handled by async callbacks
  }

  if (item.attrs.isDirectory) {
    if (currentSftpManager.value.isLoading.value) {
      return;
    }
    navigatingTargetName.value = item.filename;
    const newPath = item.filename === '..'
      ? currentSftpManager.value.currentPath.value.substring(0, currentSftpManager.value.currentPath.value.lastIndexOf('/')) || '/'
      : currentSftpManager.value.joinPath(currentSftpManager.value.currentPath.value, item.filename);
    currentSftpManager.value.loadDirectory(newPath);
  } else if (item.attrs.isFile) {
    // This block now only handles regular files, as symlinks are handled above.
    if (props.isMobile && isMultiSelectMode.value) {
      if (selectedItems.value.has(item.filename)) {
        selectedItems.value.delete(item.filename);
      } else {
        selectedItems.value.add(item.filename);
      }
      return;
    }
    const filePath = itemPath; // itemPath is already calculated
    const fileInfo: FileInfo = { name: item.filename, fullPath: filePath };

    if (settingsStore.showPopupFileEditorBoolean) {
      fileEditorStore.triggerPopup(filePath, props.sessionId);
    }

    if (shareFileEditorTabsBoolean.value) {
      fileEditorStore.openFile(filePath, props.sessionId, props.instanceId);
    } else {
      sessionStore.openFileInSession(props.sessionId, fileInfo);
    }
  }
};

// 移动端列表紧凑模式 (默认开启，支持 localStorage 持久化记忆)
const getInitialCompactMode = (): boolean => {
  try {
    const saved = localStorage.getItem('nexus:mobile_file_manager_compact');
    return saved !== null ? saved === 'true' : true;
  } catch {
    return true;
  }
};

const isCompactMode = ref<boolean>(getInitialCompactMode());

const toggleCompactMode = () => {
  isCompactMode.value = !isCompactMode.value;
  try {
    localStorage.setItem('nexus:mobile_file_manager_compact', String(isCompactMode.value));
  } catch (err) {
    console.warn('[FileManager] 保存移动端紧凑模式偏好失败:', err);
  }
};

// 切换多选模式 (主要用于移动端)
const toggleMultiSelectMode = () => {
    isMultiSelectMode.value = !isMultiSelectMode.value;
    if (!isMultiSelectMode.value) {
        clearSelection(); // 退出多选模式时清空选择
    }
    console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Multi-select mode: ${isMultiSelectMode.value ? 'enabled' : 'disabled'}`);
};

// 实例化选择 Composable (需要 filteredFileList 和 handleItemAction)
const {
  selectedItems, // 使用 Composable 返回的 selectedItems
  lastClickedIndex, // 获取 lastClickedIndex 以传递给 ContextMenu
  handleItemClick: originalHandleItemClick, // 使用 Composable 返回的 handleItemClick
  handleItemDoubleClick: originalHandleItemDoubleClick, // 使用 Composable 返回的 handleItemDoubleClick
  clearSelection, // 获取清空选择的方法
} = useFileManagerSelection({
  // 传递当前显示的列表 (已排序和过滤)
  displayedFileList: filteredFileList, // 现在 filteredFileList 已定义
  onItemAction: handleItemAction, // 传递动作回调
  doubleClickToOpen: fileManagerDoubleClickToOpenBoolean, // 传递双击打开配置
});

// 自定义 handleItemClick 函数以支持移动端多选模式
const handleItemClick = (event: MouseEvent, item: FileListItem, forceMultiSelect = false) => {
  if (props.isMobile && (isMultiSelectMode.value || forceMultiSelect)) {
    if (selectedItems.value.has(item.filename)) {
      selectedItems.value.delete(item.filename);
    } else {
      selectedItems.value.add(item.filename);
    }
    return;
  }
  originalHandleItemClick(event, item);
};

// 双击条目处理函数
const handleItemDoubleClick = (event: MouseEvent, item: FileListItem) => {
  if (props.isMobile && isMultiSelectMode.value) {
    return;
  }
  originalHandleItemDoubleClick(event, item);
};

// +++ 计算属性：获取选中的完整文件对象列表 +++
const computedSelectedFullItems = computed((): FileListItem[] => {
  if (!selectedItems.value || selectedItems.value.size === 0) {
    return [];
  }
  return filteredFileList.value.filter(item => selectedItems.value.has(item.filename));
});

// --- 核心操作与模态框管理 (Composable) ---
const triggerFileUpload = () => { fileInputRef.value?.click(); };

const {
  isActionModalVisible,
  currentActionType,
  actionItem,
  actionItems,
  actionInitialValue,
  clipboardState,
  clipboardSourcePaths,
  clipboardSourceBaseDir,
  openActionModal,
  handleModalClose,
  handleModalConfirm,
  handleDeleteSelectedClick,
  handleRenameContextMenuClick,
  handleChangePermissionsContextMenuClick,
  handleNewFolderContextMenuClick,
  handleNewFileContextMenuClick,
  handleCopy,
  handleCut,
  handlePaste,
  clearClipboard,
  handleCompress,
  handleDecompress,
  handleCopyPath,
  triggerDownload: baseTriggerDownload,
  triggerDownloadDirectory: baseTriggerDownloadDirectory,
} = useFileManagerOperations({
  currentSftpManager,
  selectedItems,
  isConnected: computed(() => props.wsDeps.isConnected.value),
  showDeleteConfirmation: fileManagerShowDeleteConfirmationBoolean,
  sessionId: props.sessionId,
  instanceId: props.instanceId,
  t,
  notifySuccess: (msg) => uiNotificationsStore.showSuccess(msg),
  notifyError: (msg) => uiNotificationsStore.showError(msg),
});

const triggerDownload = (items: FileListItem[]) => baseTriggerDownload(items, props.dbConnectionId);
const triggerDownloadDirectory = (item: FileListItem) => baseTriggerDownloadDirectory(item, props.dbConnectionId);

// --- 移动端文件专属交互与 ActionSheet 管理 ---
const activeMobileActionItem = ref<FileListItem | null>(null);
const showMobileActionSheet = ref(false);

const handleOpenMobileActionSheet = (item: FileListItem) => {
  activeMobileActionItem.value = item;
  showMobileActionSheet.value = true;
};

const handleCloseMobileActionSheet = () => {
  showMobileActionSheet.value = false;
  activeMobileActionItem.value = null;
};

const handleMobileToggleSelect = (item: FileListItem) => {
  if (selectedItems.value.has(item.filename)) {
    selectedItems.value.delete(item.filename);
  } else {
    selectedItems.value.add(item.filename);
  }
};

const handleMobileSelectAll = () => {
  filteredFileList.value.forEach(item => selectedItems.value.add(item.filename));
};

const handleMobileDeselectAll = () => {
  clearSelection();
};

const handleMobileBatchDownload = () => {
  const items = filteredFileList.value.filter(item => selectedItems.value.has(item.filename));
  if (items.length > 0) {
    triggerDownload(items);
  }
};

// 移动端批量复制：执行复制后清空已选，自动退出多选模式，激活底部剪贴坞
const handleMobileBatchCopy = () => {
  handleCopy();
  clearSelection();
  isMultiSelectMode.value = false;
};

// 移动端批量剪切：执行剪切后清空已选，自动退出多选模式，激活底部剪贴坞
const handleMobileBatchCut = () => {
  handleCut();
  clearSelection();
  isMultiSelectMode.value = false;
};

// 移动端单文件复制：执行复制后清空已选，激活底部剪贴坞
const handleMobileSingleCopy = (item: FileListItem) => {
  selectedItems.value.clear();
  selectedItems.value.add(item.filename);
  handleCopy();
  clearSelection();
  isMultiSelectMode.value = false;
};

// 移动端单文件剪切：执行剪切后清空已选，激活底部剪贴坞
const handleMobileSingleCut = (item: FileListItem) => {
  selectedItems.value.clear();
  selectedItems.value.add(item.filename);
  handleCut();
  clearSelection();
  isMultiSelectMode.value = false;
};

const handleMobileSingleDelete = (item: FileListItem) => {
  selectedItems.value.clear();
  selectedItems.value.add(item.filename);
  handleDeleteSelectedClick();
};

// 移动端执行粘贴：执行粘贴后清空剪贴板，自动关闭底部剪贴坞
const handleMobilePaste = async () => {
  await handlePaste();
  clearClipboard();
};

const handleMobileCdTerminal = (path: string) => {
  const command = `cd "${path}"\n`;
  const activeSession = sessionStore.activeSession;
  if (activeSession?.terminalManager) {
    activeSession.terminalManager.sendData(command);
  }
};

// --- 上下文菜单逻辑 (使用 Composable, 需要 Selection 和 Action Handlers) ---
const {
  contextMenuVisible,
  contextMenuPosition,
  contextMenuItems,
  contextMenuRef, // 获取 ref 以传递给子组件
  contextTargetItem, // Get the target item from the composable
  showContextMenu, // 使用 Composable 提供的函数
  hideContextMenu, // <-- 获取 hideContextMenu 函数
} = useFileManagerContextMenu({
  selectedItems,
  lastClickedIndex,
  // 修改：传递 manager 的 fileList 和 currentPath ref (保持 computed)
  fileList: computed(() => currentSftpManager.value?.fileList.value ?? []),
  currentPath: computed(() => currentSftpManager.value?.currentPath.value ?? '/'),
  isConnected: props.wsDeps.isConnected,
  isSftpReady: props.wsDeps.isSftpReady,
  clipboardState: readonly(clipboardState), // +++ 传递剪贴板状态 (只读) +++
  t,
  // --- 传递回调函数 ---
  // 修改：确保在调用前检查 currentSftpManager.value
  onRefresh: () => {
      if (currentSftpManager.value) {
          currentSftpManager.value.loadDirectory(currentSftpManager.value.currentPath.value, true);
      }
  },
  onUpload: triggerFileUpload,
  onDownload: triggerDownload,
  onDelete: handleDeleteSelectedClick,
  onRename: handleRenameContextMenuClick,
  onChangePermissions: handleChangePermissionsContextMenuClick,
  onNewFolder: handleNewFolderContextMenuClick,
  onNewFile: handleNewFileContextMenuClick,
  onCopy: handleCopy, // +++ 传递复制回调 +++
  onCut: handleCut, // +++ 传递剪切回调 +++
  onPaste: handlePaste, // +++ 传递粘贴回调 +++
  onDownloadDirectory: triggerDownloadDirectory, // +++ 传递文件夹下载回调 +++
  // +++ 传递压缩/解压回调 +++
  onCompressRequest: handleCompress,
  onDecompressRequest: handleDecompress,
  onCopyPath: handleCopyPath, // +++ 传递复制路径回调 +++
});

// --- 目录加载与导航 ---
// loadDirectory is provided by props.sftpManager

const subscribeToWorkspaceEvent = useWorkspaceEventSubscriber();
const unsubscribeFromWorkspaceEvent = useWorkspaceEventOff();

const handleMoveItems = (sourcePaths: string[], destinationDir: string) => {
  if (!currentSftpManager.value || sourcePaths.length === 0) return;

  console.log(`[FileManager ${props.sessionId}-${props.instanceId}] 执行移动操作: sources=${sourcePaths.join(', ')} -> dest=${destinationDir}`);
  currentSftpManager.value.moveItems(sourcePaths, destinationDir);
};

// --- 拖放逻辑 (使用 Composable) ---
const {
  // isDraggingOver, // 不再直接使用容器的悬停状态
  showExternalDropOverlay, // 控制蒙版显示
  dragOverTarget, // 行拖拽悬停目标 (内部)
  isContainerDropTarget, // 跨窗格拖拽到列表空白区域的高亮指示
  // draggedItem, // 内部状态，不需要在 FileManager 中直接使用
  // --- 事件处理器 ---
  handleDragEnter,
  handleDragOver, // 容器的 dragover (主要处理内部滚动)
  handleDragLeave,
  handleDrop, // 容器的 drop (主要用于清理)
  handleOverlayDrop, // 蒙版的 drop
  handleDragStart,
  handleDragEnd,
  handleDragOverRow,
  handleDragLeaveRow,
  handleDropOnRow,
} = useFileManagerDragAndDrop({
  sessionId: computed(() => props.sessionId),
  instanceId: props.instanceId,
  isConnected: computed(() => props.wsDeps.isConnected.value), 
  currentPath: computed(() => currentSftpManager.value?.currentPath.value ?? '/'),
  fileListContainerRef: fileListContainerRef,
  joinPath: (base: string, target: string): string => {
      return currentSftpManager.value?.joinPath(base, target) ?? `${base}/${target}`.replace(/\/+/g, '/');
  },
  onFileUpload: startFileUpload,
  onMoveItems: handleMoveItems,
  selectedItems: selectedItems,
  fileList: computed(() => currentSftpManager.value?.fileList.value ?? []),
});


// --- 文件上传逻辑 (handleFileSelected 保持在此处，由 triggerFileUpload 调用) ---
const handleFileSelected = (event: Event) => {
    const input = event.target as HTMLInputElement;
    // 恢复使用 props.wsDeps.isConnected
    if (!input.files || !props.wsDeps.isConnected.value) return;
    // --- 修正：使用匿名函数包装 startFileUpload 调用 ---
    Array.from(input.files).forEach(file => startFileUpload(file)); // 只传递 file 参数
    // --- 结束修正 ---
    input.value = '';
};

// --- 虚拟滚动逻辑 (使用 Composable) ---
const hasParentLink = computed(() => {
  return Boolean(currentSftpManager.value && currentSftpManager.value.currentPath.value !== '/');
});

const {
  visibleItems,
  topPadding,
  bottomPadding,
  scrollToIndex: virtualScrollToIndex,
  setScrollTop: virtualSetScrollTop,
} = useFileManagerVirtualScroll({
  items: filteredFileList,
  containerRef: fileListContainerRef,
  rowSizeMultiplier,
  hasParentLink,
});

// --- 滚动位置平稳还原 (支持虚拟列表切片与平铺视图，等待 DOM 完全撑开后对齐) ---
const applySavedScrollPosition = (retryCount = 0) => {
  const container = fileListContainerRef.value;
  // 1. 如果容器不可见（后台非激活会话，display: none），暂缓至切回会话时执行
  if (!container || container.offsetParent === null || container.clientHeight === 0) {
    return;
  }

  // 2. 检查 SFTP 是否真正完成初次拉取并有文件列表渲染
  const manager = currentSftpManager.value;
  if (!manager || !manager.initialLoadDone.value || manager.isLoading.value || filteredFileList.value.length === 0) {
    return;
  }

  const savedState = workspaceSyncStore.getSavedFileManagerInstanceState(props.sessionId, props.instanceId)
    || (props.sessionId === sessionStore.activeSessionId ? workspaceSyncStore.fileManagerState : null);
  const targetScrollTop = savedState?.scrollTop;
  const targetScrollRatio = savedState?.scrollRatio;

  const hasSavedScroll = (typeof targetScrollTop === 'number' && targetScrollTop > 0)
    || (typeof targetScrollRatio === 'number' && targetScrollRatio > 0);

  if (hasSavedScroll) {
    const currentMaxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

    // 3. 检查容器是否真正排版并产生可滚动的 scrollHeight（若尚未展开则等待重试）
    if (currentMaxScroll <= 10 && retryCount < 12) {
      setTimeout(() => applySavedScrollPosition(retryCount + 1), 60);
      return;
    }

    // 核心：自适应计算有效滚动位置 (兼容跨端与屏幕视口高差)
    let effectiveScrollTop = targetScrollTop || 0;
    if (typeof targetScrollRatio === 'number') {
      if (targetScrollRatio >= 0.98) {
        // 智能吸附：原端拉到底部，当前端精准吸附到当前设备的最大底部
        effectiveScrollTop = currentMaxScroll;
      } else if (targetScrollRatio <= 0.02) {
        effectiveScrollTop = 0;
      } else if (props.isMobile || targetScrollTop === undefined || targetScrollTop > currentMaxScroll) {
        // 移动端或跨分辨率场景：按相对滚动比例映射当前容器最大高度
        effectiveScrollTop = Math.round(targetScrollRatio * currentMaxScroll);
      } else {
        // 同分辨率桌面端：优先使用像素级精确位置，并以 currentMaxScroll 为上限
        effectiveScrollTop = Math.min(targetScrollTop, currentMaxScroll);
      }
    } else {
      effectiveScrollTop = Math.min(effectiveScrollTop, currentMaxScroll);
    }

    console.log(`[FileManager ${props.sessionId}-${props.instanceId}] 还原滚动位置: ${effectiveScrollTop}px (ratio: ${targetScrollRatio ?? 'none'}, 可滚高度: ${currentMaxScroll}px, 视口: ${container.clientHeight}px, 重试: ${retryCount})`);
    isRestoringScroll.value = true;

    // 同步虚拟滚动内部 slice
    virtualSetScrollTop(effectiveScrollTop);

    nextTick(() => {
      if (!fileListContainerRef.value) return;
      fileListContainerRef.value.scrollTop = effectiveScrollTop;

      setTimeout(() => {
        if (!fileListContainerRef.value) return;
        const currentTop = fileListContainerRef.value.scrollTop;
        if (Math.abs(currentTop - effectiveScrollTop) > 10 && retryCount < 12) {
          virtualSetScrollTop(effectiveScrollTop);
          fileListContainerRef.value.scrollTop = effectiveScrollTop;
          setTimeout(() => {
            applySavedScrollPosition(retryCount + 1);
          }, 60);
          return;
        }

        // 真实设置成功后，才标记初始还原完成
        hasRestoredInitialScroll.value = true;
        setTimeout(() => {
          isRestoringScroll.value = false;
        }, 150);
      }, 50);
    });
  } else {
    hasRestoredInitialScroll.value = true;
  }
};

// 监听文件列表首次加载完成：当 SFTP 真正完成初始加载、不在 loading 且有真实文件数据时，可靠恢复历史滚动条位置
watch(
  [
    () => currentSftpManager.value?.initialLoadDone.value,
    () => currentSftpManager.value?.isLoading.value,
    () => filteredFileList.value.length
  ],
  ([initDone, loading, len]) => {
    if (initDone && !loading && len > 0 && !hasRestoredInitialScroll.value) {
      nextTick(() => {
        applySavedScrollPosition();
      });
    }
  }
);

// 监听会话激活状态切换：当切回本会话时，防止因隐藏重现导致浏览器滚动条被归零，并保持窗格视图与目录树同步
watch(
  () => sessionStore.activeSessionId,
  (activeId) => {
    if (activeId === props.sessionId) {
      // 1. 同步统一组件的最新视图模式与目录树状态
      const latestViewMode = componentStateStore.getState<'list' | 'tile'>(viewModeStorageKey.value, viewMode.value);
      if (viewMode.value !== latestViewMode) {
        viewMode.value = latestViewMode;
      }
      const latestShowTree = getInitialDirectoryTreeVisible(effectiveInstanceId.value);
      if (showDirectoryTree.value !== latestShowTree) {
        showDirectoryTree.value = latestShowTree;
      }
      const latestTreeWidth = getInitialDirectoryTreeWidth(effectiveInstanceId.value);
      if (directoryTreeWidth.value !== latestTreeWidth) {
        directoryTreeWidth.value = latestTreeWidth;
      }

      // 2. 切回本会话，执行滚动条平稳还原（无论是初次切回还是后续切回）
      nextTick(() => {
        applySavedScrollPosition();
      });
    }
  }
);

// --- 键盘导航逻辑 (使用 Composable) ---
const {
  selectedIndex, // 使用 Composable 返回的 selectedIndex
  handleKeydown, // 使用 Composable 返回的 handleKeydown
} = useFileManagerKeyboardNavigation({
  filteredFileList: filteredFileList,
  // 传递 manager 的 currentPath ref
  currentPath: computed(() => currentSftpManager.value?.currentPath.value ?? '/'),
  fileListContainerRef: fileListContainerRef,
  // 当 Enter 键按下时，模拟鼠标单击
  onEnterPress: (item) => handleItemClick(new MouseEvent('click'), item),
  onScrollToIndex: (index) => {
    if (viewMode.value === 'list') {
      if (hasParentLink.value) {
        if (index === 0) {
          if (fileListContainerRef.value) fileListContainerRef.value.scrollTop = 0;
        } else {
          virtualScrollToIndex(index - 1);
        }
      } else {
        virtualScrollToIndex(index);
      }
    } else {
      nextTick(() => {
        const container = fileListContainerRef.value;
        if (!container) return;
        const cards = container.querySelectorAll('[data-filename]');
        if (cards[index]) {
          (cards[index] as HTMLElement).scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        }
      });
    }
  },
});


// 监听 manager 的 currentPath：路径更换时自动重置选择、清空搜索栏并在切实发生用户主动切目录时重置滚动条
watch(() => currentSftpManager.value?.currentPath.value, (newPath, oldPath) => {
    selectedIndex.value = -1;
    clearSelection();
    // 当识别到更换了路径后，自动清空搜索栏并收起搜索状态
    if (newPath !== oldPath) {
        searchQuery.value = '';
        isSearchActive.value = false;
        // 关键防护：只有在 initialLoadDone 为 true 且已完成过初始滚动还原之后，才判定为用户主动导航切目录，重置滚动条
        const isUserNavigated = Boolean(currentSftpManager.value?.initialLoadDone.value && hasRestoredInitialScroll.value);
        if (oldPath && isUserNavigated) {
          hasRestoredInitialScroll.value = false;
          if (fileListContainerRef.value) {
            virtualSetScrollTop(0);
          }
          workspaceSyncStore.updateFileManagerInstanceState(props.sessionId, props.instanceId, { scrollTop: 0 });
        }
    }
});
watch(searchQuery, () => {
    selectedIndex.value = -1;
    clearSelection(); // 清空选择
});
watch(sortKey, () => {
    selectedIndex.value = -1;
    clearSelection(); // 清空选择
});
watch(sortDirection, () => {
    selectedIndex.value = -1;
    clearSelection(); // 清空选择
});


// --- 保存设置的函数 ---
const saveLayoutSettings = () => {
  // 确保 colWidths.value 是普通对象，而不是 Proxy
  const widthsToSave = JSON.parse(JSON.stringify(colWidths.value));
  // +++ 日志：记录保存的值 +++
  console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Triggering saveLayoutSettings: multiplier=${rowSizeMultiplier.value}, widths=${JSON.stringify(widthsToSave)}`);
  settingsStore.updateFileManagerLayoutSettings(rowSizeMultiplier.value, widthsToSave);
};

// --- 生命周期钩子 ---
onMounted(() => {
  componentStateStore.initialize();
  // 恢复云端工作区的搜索状态 (优先读取本会话专属实例状态)
  if (workspaceSyncStore.syncEnabled) {
    const savedState = workspaceSyncStore.getSavedFileManagerInstanceState(props.sessionId, props.instanceId) || workspaceSyncStore.fileManagerState;
    if (savedState) {
      if (savedState.isSearchActive) {
        isSearchActive.value = true;
        searchQuery.value = savedState.searchQuery || '';
      }
    }
  }
});

// +++ 使用 watchEffect 响应式地加载和应用布局设置 +++
watchEffect(() => {
  // 检查 store 中的值是否有效 (避免在 store 加载完成前使用默认值覆盖本地 ref)
  // fileManagerColWidthsObject 初始可能是空对象 {}，需要检查其是否有键
  const storeMultiplier = fileManagerRowSizeMultiplierNumber.value;
  const storeWidths = fileManagerColWidthsObject.value;

  // +++ 日志：记录从 store 获取的值 +++
  console.log(`[FileManager ${props.sessionId}-${props.instanceId}] watchEffect triggered. Store values: multiplier=${storeMultiplier}, widths=${JSON.stringify(storeWidths)}`);

  // 只有当 store 加载完成并提供了有效值时才更新
  // 假设 store 加载完成后 multiplier > 0 且 widths 对象有内容
  if (storeMultiplier > 0 && Object.keys(storeWidths).length > 0) {
    const currentMultiplier = rowSizeMultiplier.value;
    const currentWidthsString = JSON.stringify(colWidths.value);
    const storeWidthsString = JSON.stringify(storeWidths);

    // +++ 日志：记录当前值和 store 值，以及是否更新 +++
    console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Comparing values: Current Multiplier=${currentMultiplier}, Store Multiplier=${storeMultiplier}. Update needed: ${storeMultiplier !== currentMultiplier}`);
    console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Comparing values: Current Widths=${currentWidthsString}, Store Widths=${storeWidthsString}. Update needed: ${storeWidthsString !== currentWidthsString}`);

    // 仅在值不同时更新，避免不必要的重渲染和潜在的循环更新
    if (storeMultiplier !== currentMultiplier) {
      rowSizeMultiplier.value = storeMultiplier;
      console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Row size multiplier updated from store: ${storeMultiplier}`);
    }
    if (storeWidthsString !== currentWidthsString) {
      // --- 修改：合并 storeWidths 到 colWidths.value ---
      // 确保 colWidths.value 的所有键都存在，并用 store 的值更新（如果存在且有效）
      const updatedWidths = { ...colWidths.value }; // 创建当前值的副本
      for (const key in updatedWidths) {
        if (storeWidths[key] !== undefined && typeof storeWidths[key] === 'number' && storeWidths[key] > 0) {
          updatedWidths[key as keyof typeof updatedWidths] = storeWidths[key];
        }
      }
      colWidths.value = updatedWidths; // 赋值更新后的对象
      console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Column widths updated from store: ${JSON.stringify(updatedWidths)}`);
    }
  } else {
    // +++ 日志：记录等待 store 加载 +++
    console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Waiting for valid layout settings from store... Store Multiplier=${storeMultiplier}, Store Widths Keys=${Object.keys(storeWidths).length}`);
  }
});

// 使用 watchEffect 监听连接和 SFTP 就绪状态以触发初始加载
// 恢复使用 props.wsDeps
watchEffect((onCleanup) => {
    let unregisterSuccess: (() => void) | undefined;
    let unregisterError: (() => void) | undefined;
    let timeoutId: NodeJS.Timeout | number | undefined; // 修正类型以兼容 Node 和浏览器环境

    const cleanupListeners = () => {
        unregisterSuccess?.();
        unregisterError?.();
        if (timeoutId) clearTimeout(timeoutId);
        // isFetchingInitialPath 状态移除
    };

    onCleanup(cleanupListeners);

    // 优先检查是否有来自云端快照的有效绝对恢复路径 (仅当该会话明确拥有云端快照记录时优先恢复)
    if (currentSftpManager.value && props.wsDeps.isConnected.value && props.wsDeps.isSftpReady.value && !currentSftpManager.value.isLoading.value && !currentSftpManager.value.initialLoadDone.value) {
        const isTargetValid = (p?: string | null): p is string => !!p && p.trim().startsWith('/');
        const syncPath = workspaceSyncStore.getSavedFileManagerPath(props.sessionId, props.instanceId);

        // 仅当明确存在专属快照路径时直接加载（新会话 syncPath 为 null，强制执行后续 realpath 获取默认家目录）
        if (isTargetValid(syncPath)) {
            console.log(`%c[WorkspaceSync] FileManager ${props.sessionId}-${props.instanceId} 检测到本会话专属云端快照路径: ${syncPath}，优先平稳加载并完成初始阶段`, 'color: #10b981;');
            currentSftpManager.value.loadDirectory(syncPath!);
            currentSftpManager.value.setInitialLoadDone(true);
            return;
        }

        console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Connection ready for manager, fetching initial path for the first time (isLoading: ${currentSftpManager.value.isLoading.value}, initialLoadDone: ${currentSftpManager.value.initialLoadDone.value}).`);
        // isFetchingInitialPath 状态移除, 使用 isLoading 状态

        // 仍然使用 props.wsDeps 中的 sendMessage 和 onMessage
        const { sendMessage: wsSend, onMessage: wsOnMessage } = props.wsDeps;
        const requestId = generateRequestId(); // 使用本地辅助函数
        const requestedPath = '.';

        unregisterSuccess = wsOnMessage('sftp:realpath:success', (payload: any, message: WebSocketMessage) => { // message 已有类型
            if (message.requestId === requestId && payload.requestedPath === requestedPath) {
                if (!currentSftpManager.value) return;
                // 如果当前路径已经被云端快照显式设置为其它有效路径，保持快照路径
                const latestSyncPath = workspaceSyncStore.getSavedFileManagerPath(props.sessionId, props.instanceId);
                if (isTargetValid(latestSyncPath) && latestSyncPath !== payload.absolutePath) {
                    console.log(`%c[WorkspaceSync] FileManager ${props.sessionId}-${props.instanceId} 保持云端同步路径: ${latestSyncPath}，忽略默认 realpath: ${payload.absolutePath}`, 'color: #10b981;');
                    currentSftpManager.value?.loadDirectory(latestSyncPath);
                } else {
                    const absolutePath = payload.absolutePath;
                    console.log(`%c[WorkspaceSync] FileManager ${props.sessionId}-${props.instanceId} 收到默认初始绝对路径: ${absolutePath}，加载目录`, 'color: #10b981;');
                    currentSftpManager.value?.loadDirectory(absolutePath);
                    // 确保将此真实有效路径同步回 store (仅在非恢复状态下覆盖，避免冲刷云端快照路径)
                    if (isTargetValid(absolutePath) && !workspaceSyncStore.isRestoring) {
                        workspaceSyncStore.updateFileManagerInstanceState(props.sessionId, props.instanceId, { currentPath: absolutePath });
                    }
                }
                currentSftpManager.value?.setInitialLoadDone(true); // 设置 manager 内部状态
                cleanupListeners();
            }
        });

        unregisterError = wsOnMessage('sftp:realpath:error', (payload: any, message: WebSocketMessage) => { // message 已有类型
            // 修改：使用 payload.requestedPath (如果存在) 或 message.requestId 匹配
            if (message.requestId === requestId && payload?.requestedPath === requestedPath) {
                console.error(`[FileManager ${props.sessionId}-${props.instanceId}] Failed to get realpath for '${requestedPath}':`, payload);
                // TODO: 可以考虑通过 manager instance 暴露错误状态
                // 目前仅记录日志。
                // 即使获取 realpath 失败，也标记初始加载尝试完成，避免重复尝试
                currentSftpManager.value?.setInitialLoadDone(true);
                cleanupListeners();
            }
        });

        console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Sending initial sftp:realpath request (ID: ${requestId}) for path: ${requestedPath}`);
        wsSend({ type: 'sftp:realpath', requestId: requestId, payload: { path: requestedPath } });

        timeoutId = setTimeout(() => {
            console.error(`[FileManager ${props.sessionId}-${props.instanceId}] Timeout getting initial realpath for '.' (ID: ${requestId}).`);
            // 超时也标记初始加载尝试完成
            currentSftpManager.value?.setInitialLoadDone(true);
            cleanupListeners();
        }, 10000); // 10 秒超时

    } else if (currentSftpManager.value && props.wsDeps.isConnected.value && props.wsDeps.isSftpReady.value && currentSftpManager.value.initialLoadDone.value) {
        // 连接恢复，并且之前已经加载过 (initialLoadDone is true)
        // 显式地重新加载管理器中记录的当前路径，以防内部状态被重置
        const pathBeforeReconnect = currentSftpManager.value.currentPath.value;
        console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Connection re-established. Explicitly reloading previous path: ${pathBeforeReconnect}`);
        // 检查是否正在加载，避免并发请求
        if (!currentSftpManager.value.isLoading.value) {
             // 使用 false 参数可能表示非强制刷新，如果 SFTP 管理器支持的话
             // 主要目的是确保视图与管理器状态同步到重连前的路径
            currentSftpManager.value.loadDirectory(pathBeforeReconnect, false);
        } else {
            console.log(`[FileManager ${props.sessionId}-${props.instanceId}] SFTP manager is currently loading, skipping explicit path reload on reconnect.`);
        }
        cleanupListeners(); // 清理可能存在的旧监听器

    } else if (!props.wsDeps.isConnected.value && currentSftpManager.value?.initialLoadDone.value) { // 检查 manager 的 initialLoadDone
        // 连接丢失，不需要重置 initialLoadDone，因为我们希望在重连时恢复状态
        // 只需要清理监听器
        console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Connection lost (was previously loaded).`);
        // clearSelection(); // 可以在连接丢失时不清空选择，看产品需求
        // currentSftpManager.value?.setInitialLoadDone(false); // 不再重置，保持状态
        cleanupListeners();
    }
});

// +++ 监听 Store 中的触发器以激活搜索 +++
watch(() => focusSwitcherStore.activateFileManagerSearchTrigger, (newValue, oldValue) => { // 修改监听器
    // 确保只在触发器值增加时执行（避免初始加载或重置时触发）
    // 并且当前组件的 sessionId 与活动 sessionId 匹配
    // 检查 newValue > oldValue 确保是递增触发，避免重复执行
    // 检查是否是当前活动会话的此实例（如果需要区分实例）
    // 目前假设搜索触发器对会话内的所有 FileManager 生效
    if (newValue > (oldValue ?? 0) && props.sessionId === sessionStore.activeSessionId) {
        console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Received search activation trigger for active session.`);
        focusSearchInput();
    }
}, { immediate: false }); // 添加 immediate: false 避免初始值为 0 时触发


// --- 监听 sessionId prop 的变化 ---
watch(() => props.sessionId, (newSessionId, oldSessionId) => {
    if (newSessionId && newSessionId !== oldSessionId) {
        breadcrumbsRef.value?.cancelEdit();
        // 1. 重新初始化 SFTP 管理器
        initializeSftpManager(newSessionId, props.instanceId);

        // 2. 重置 UI 状态
        clearSelection();
        searchQuery.value = '';
        isSearchActive.value = false;
        sortKey.value = 'filename'; // 重置排序
        sortDirection.value = 'asc';
    }
}, { immediate: false });

// +++ 注册/注销自定义聚焦动作与跨会话联动事件 +++
let unregisterSearchFocusAction: (() => void) | null = null;
let unregisterPathFocusAction: (() => void) | null = null;

let unregisterItemsMovedEvent: (() => void) | null = null;
let unregisterNavigateToPathEvent: (() => void) | null = null;
let unregisterSetDirectoryTreeVisibleEvent: (() => void) | null = null;
let unregisterSetDirectoryTreeWidthEvent: (() => void) | null = null;
let unregisterSetViewModeEvent: (() => void) | null = null;

onMounted(() => {
  // 同组件实例跨会话目录树显隐联动
  const handleSetDirectoryTreeVisibleNotification = (payload: { instanceId: string; show: boolean }) => {
    if (payload.instanceId === effectiveInstanceId.value && showDirectoryTree.value !== payload.show) {
      showDirectoryTree.value = payload.show;
    }
  };
  subscribeToWorkspaceEvent('fileManager:setDirectoryTreeVisible', handleSetDirectoryTreeVisibleNotification);
  unregisterSetDirectoryTreeVisibleEvent = () => unsubscribeFromWorkspaceEvent('fileManager:setDirectoryTreeVisible', handleSetDirectoryTreeVisibleNotification);

  // 同组件实例跨会话目录树宽度联动
  const handleSetDirectoryTreeWidthNotification = (payload: { instanceId: string; width: number }) => {
    if (payload.instanceId === effectiveInstanceId.value && directoryTreeWidth.value !== payload.width) {
      directoryTreeWidth.value = payload.width;
    }
  };
  subscribeToWorkspaceEvent('fileManager:setDirectoryTreeWidth', handleSetDirectoryTreeWidthNotification);
  unregisterSetDirectoryTreeWidthEvent = () => unsubscribeFromWorkspaceEvent('fileManager:setDirectoryTreeWidth', handleSetDirectoryTreeWidthNotification);

  // 同组件实例跨会话视图模式联动
  const handleSetViewModeNotification = (payload: { instanceId: string; viewMode: 'list' | 'tile' }) => {
    if (payload.instanceId === effectiveInstanceId.value && viewMode.value !== payload.viewMode) {
      viewMode.value = payload.viewMode;
    }
  };
  subscribeToWorkspaceEvent('fileManager:setViewMode', handleSetViewModeNotification);
  unregisterSetViewModeEvent = () => unsubscribeFromWorkspaceEvent('fileManager:setViewMode', handleSetViewModeNotification);

  const handleItemsMovedNotification = (payload: { sessionId: string; sourceDir: string; targetDir: string }) => {
    if (payload.sessionId === props.sessionId) {
      const current = currentSftpManager.value?.currentPath.value;
      if (current && (current === payload.sourceDir || current === payload.targetDir)) {
        console.log(`[FileManager ${props.sessionId}-${props.instanceId}] 收到移动文件广播，自动静默刷新当前目录: ${current}`);
        currentSftpManager.value?.loadDirectory(current, true);
      }
    }
  };
  subscribeToWorkspaceEvent('fileManager:itemsMoved', handleItemsMovedNotification);
  unregisterItemsMovedEvent = () => unsubscribeFromWorkspaceEvent('fileManager:itemsMoved', handleItemsMovedNotification);

  const handleNavigateToPathNotification = (payload: { path: string; sessionId?: string; instanceId?: string }) => {
    // 如果指定了 sessionId，必须与当前实例的 sessionId 匹配
    if (payload.sessionId && payload.sessionId !== props.sessionId) {
      return;
    }
    // 如果指定了 instanceId，必须与当前组件的 instanceId 匹配（避免多分屏实例互串）
    if (payload.instanceId && payload.instanceId !== props.instanceId) {
      return;
    }
    if (payload.path && currentSftpManager.value) {
      console.log(`[FileManager ${props.sessionId}-${props.instanceId}] 收到路径跳转通知: ${payload.path}`);
      currentSftpManager.value.loadDirectory(payload.path);
      currentSftpManager.value.setInitialLoadDone(true);
    }
  };
  subscribeToWorkspaceEvent('fileManager:navigateToPath', handleNavigateToPathNotification);
  unregisterNavigateToPathEvent = () => unsubscribeFromWorkspaceEvent('fileManager:navigateToPath', handleNavigateToPathNotification);

  const focusSearchActionWrapper = async (): Promise<boolean | undefined> => {
    if (props.sessionId === sessionStore.activeSessionId) {
      return focusSearchInput();
    }
    return undefined;
  };
  unregisterSearchFocusAction = focusSwitcherStore.registerFocusAction('fileManagerSearch', focusSearchActionWrapper);

  const focusPathActionWrapper = async (): Promise<boolean | undefined> => {
     if (props.sessionId === sessionStore.activeSessionId) {
       startPathEdit();
       return true;
     }
     return undefined;
  };
  unregisterPathFocusAction = focusSwitcherStore.registerFocusAction('fileManagerPathInput', focusPathActionWrapper);
});

onBeforeUnmount(() => {
  if (unregisterSetDirectoryTreeVisibleEvent) {
    unregisterSetDirectoryTreeVisibleEvent();
    unregisterSetDirectoryTreeVisibleEvent = null;
  }
  if (unregisterSetDirectoryTreeWidthEvent) {
    unregisterSetDirectoryTreeWidthEvent();
    unregisterSetDirectoryTreeWidthEvent = null;
  }
  if (unregisterSetViewModeEvent) {
    unregisterSetViewModeEvent();
    unregisterSetViewModeEvent = null;
  }
  if (unregisterItemsMovedEvent) {
    unregisterItemsMovedEvent();
    unregisterItemsMovedEvent = null;
  }
  if (unregisterNavigateToPathEvent) {
    unregisterNavigateToPathEvent();
    unregisterNavigateToPathEvent = null;
  }
  if (unregisterSearchFocusAction) {
    unregisterSearchFocusAction();
  }
  unregisterSearchFocusAction = null;

  if (unregisterPathFocusAction) {
    unregisterPathFocusAction();
  }
  unregisterPathFocusAction = null;
  sessionStore.removeSftpManager(props.sessionId, props.instanceId);

  // 当检测不到该文件管理器组件存在于布局中时，移除该存储项（独立实例垃圾回收）
  const instance = props.instanceId;
  const permanentList = ['modal', 'default', 'sidebar-left', 'sidebar-right'];
  if (instance && !permanentList.includes(instance)) {
    try {
      const activeIds = layoutStore.getAllActivePaneIds ? layoutStore.getAllActivePaneIds() : new Set<string>();
      if (!activeIds.has(instance)) {
        void componentStateStore.removeState(`fm_view_mode:desktop:${instance}`);
        void componentStateStore.removeState(`fm_view_mode:mobile:${instance}`);
      }
    } catch (e) {
      console.warn('[FileManager] 卸载时清理组件状态失败:', e);
    }
  }
});

// +++ 监听蒙版可见性，动态调整高度 +++
watch(showExternalDropOverlay, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      if (dropOverlayRef.value && fileListContainerRef.value) {
        const scrollHeight = fileListContainerRef.value.scrollHeight;
        dropOverlayRef.value.style.height = `${scrollHeight}px`;
      }
    });
  } else {
    if (dropOverlayRef.value) {
      dropOverlayRef.value.style.height = '';
    }
  }
});

// --- 返回上一级目录辅助函数 ---
const handleGoParent = () => {
  if (!currentSftpManager.value) return;
  const current = currentSftpManager.value.currentPath.value;
  const newPath = current === '/' ? '/' : current.substring(0, current.lastIndexOf('/')) || '/';
  currentSftpManager.value.loadDirectory(newPath);
};

// --- 发送 CD 命令到终端的方法 ---
const sendCdCommandToTerminal = () => {
  if (!currentSftpManager.value || !props.wsDeps.isConnected.value) {
    console.warn(`[FileManager ${props.sessionId}-${props.instanceId}] Cannot send CD command: SFTP manager not ready or not connected.`);
    return;
  }
  const currentPath = currentSftpManager.value.currentPath.value;
  if (!currentPath) {
    console.warn(`[FileManager ${props.sessionId}-${props.instanceId}] Cannot send CD command: Current path is empty.`);
    return;
  }

  const escapedPath = `"${currentPath}"`;
  const command = `cd ${escapedPath}\n`;

  console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Sending command to terminal: ${command.trim()}`);
  try {
    const activeSession = sessionStore.activeSession;
    if (!activeSession) {
      console.error(`[FileManager ${props.sessionId}-${props.instanceId}] Failed to send command: No active session found.`);
      return;
    }
    if (!activeSession.terminalManager) {
      console.error(`[FileManager ${props.sessionId}-${props.instanceId}] Failed to send command: Terminal manager not found for active session.`);
      return;
    }
    activeSession.terminalManager.sendData(command);
  } catch (error) {
    console.error(`[FileManager ${props.sessionId}-${props.instanceId}] Failed to send command to terminal:`, error);
  }
};

// --- 打开弹窗编辑器的方法 ---
const openPopupEditor = () => {
  if (!props.sessionId) {
    console.error('[FileManager] Cannot open popup editor: Missing session ID.');
    return;
  }
  console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Triggering popup editor without specific file.`);
  fileEditorStore.triggerPopup('', props.sessionId);
};

// --- 行大小调整逻辑 ---
const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey) {
        event.preventDefault();
        const delta = event.deltaY > 0 ? -0.05 : 0.05;
        const newMultiplier = Math.max(0.5, Math.min(2, rowSizeMultiplier.value + delta));
        const oldMultiplier = rowSizeMultiplier.value;
        rowSizeMultiplier.value = parseFloat(newMultiplier.toFixed(2));
        if (rowSizeMultiplier.value !== oldMultiplier) {
            console.log(`[FileManager ${props.sessionId}-${props.instanceId}] handleWheel triggered saveLayoutSettings.`);
            saveLayoutSettings();
        }
    }
};

// --- 面包屑直接打开文件处理 ---
const handleBreadcrumbOpenFile = (fileItem: FileListItem, fullPath?: string) => {
  const filePath = fullPath || (currentSftpManager.value ? currentSftpManager.value.joinPath(currentSftpManager.value.currentPath.value, fileItem.filename) : fileItem.filename);
  const fileInfo: FileInfo = { name: fileItem.filename, fullPath: filePath };

  if (settingsStore.showPopupFileEditorBoolean) {
    fileEditorStore.triggerPopup(filePath, props.sessionId);
  }

  if (shareFileEditorTabsBoolean.value) {
    fileEditorStore.openFile(filePath, props.sessionId, props.instanceId);
  } else {
    sessionStore.openFileInSession(props.sessionId, fileInfo);
  }
};

// --- 桌面端独立搜索栏状态与操作 ---
const desktopSearchInputRef = ref<HTMLInputElement | null>(null);

const currentDirectoryName = computed(() => {
  const p = currentSftpManager.value?.currentPath.value || '/';
  if (p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '/';
});

const closeDesktopSearch = () => {
  isSearchActive.value = false;
  searchQuery.value = '';
};

// 监听 isSearchActive 变化，桌面端激活时自动获得焦点
watch(isSearchActive, (active) => {
  if (active && !props.isMobile) {
    nextTick(() => {
      desktopSearchInputRef.value?.focus();
    });
  }
});

// +++ 暴露给外部与焦点切换器的操作 +++
const focusSearchInput = (): boolean => {
  if (props.sessionId !== sessionStore.activeSessionId) {
    return false;
  }
  if (props.isMobile) {
    return headerRef.value?.focusSearchInput() ?? false;
  }
  isSearchActive.value = true;
  nextTick(() => {
    desktopSearchInputRef.value?.focus();
  });
  return true;
};

const startPathEdit = () => {
  if (props.sessionId === sessionStore.activeSessionId) {
    breadcrumbsRef.value?.startEdit();
  }
};

defineExpose({ focusSearchInput, startPathEdit });
</script>

<template>
  <div class="flex flex-col h-full min-h-0 overflow-hidden bg-background text-foreground text-sm">
    <!-- 隐藏文件上传 input（由 Header 或拖拽触发） -->
    <input type="file" ref="fileInputRef" @change="handleFileSelected" multiple class="hidden" />

    <!-- 顶部单行操作工具栏 -->
    <FileManagerHeader
      ref="headerRef"
      :current-path="currentSftpManager?.currentPath?.value ?? '/'"
      :is-connected="Boolean(props.wsDeps.isConnected.value)"
      :is-loading="Boolean(currentSftpManager?.isLoading?.value)"
      :is-mobile="props.isMobile"
      :is-multi-select-mode="isMultiSelectMode"
      :is-compact-mode="isCompactMode"
      :show-directory-tree="showDirectoryTree"
      :view-mode="viewMode"
      :show-popup-file-editor="showPopupFileEditorBoolean"
      v-model:search-query="searchQuery"
      v-model:is-search-active="isSearchActive"
      @toggle-directory-tree="toggleDirectoryTree"
      @toggle-view-mode="toggleViewMode"
      @cd-to-terminal="sendCdCommandToTerminal"
      @open-popup-editor="openPopupEditor"
      @upload-files="triggerFileUpload"
      @new-folder="handleNewFolderContextMenuClick"
      @new-file="handleNewFileContextMenuClick"
      @toggle-multi-select="toggleMultiSelectMode"
      @toggle-compact-mode="toggleCompactMode"
      @keydown-search="handleKeydown"
    />

    <!-- 第二层：全宽 Windows Explorer 风格面包屑交互地址栏 -->
    <FileManagerBreadcrumbs
      ref="breadcrumbsRef"
      class="flex-shrink-0"
      :current-path="currentSftpManager?.currentPath?.value ?? '/'"
      :is-connected="Boolean(props.wsDeps.isConnected.value)"
      :is-loading="Boolean(currentSftpManager?.isLoading?.value)"
      :is-mobile="props.isMobile"
      :sftp-manager="currentSftpManager"
      @navigate-to-path="(path) => currentSftpManager?.loadDirectory(path)"
      @open-file="handleBreadcrumbOpenFile"
      @refresh="() => currentSftpManager?.loadDirectory(currentSftpManager?.currentPath?.value ?? '/', true)"
    />

    <!-- 第三层：桌面端独立搜索栏（点击顶栏搜索按钮后在下方新建一行，支持当前选中目录即时搜索） -->
    <div
      v-if="!props.isMobile && isSearchActive"
      class="px-3 py-1.5 bg-header/90 border-b border-border/50 flex items-center gap-2.5 text-xs flex-shrink-0 animate-in slide-in-from-top-1 duration-150 shadow-sm"
    >
      <div class="relative flex-1 flex items-center">
        <i class="fas fa-search absolute left-2.5 text-text-secondary/70 text-xs pointer-events-none"></i>
        <input
          ref="desktopSearchInputRef"
          type="text"
          v-model="searchQuery"
          :placeholder="`在 ${currentDirectoryName} 中搜索文件...`"
          class="w-full h-7 bg-background border border-border/70 rounded-md pl-8 pr-7 text-xs text-foreground placeholder:text-text-secondary/50 outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
          data-focus-id="fileManagerSearch"
          @keyup.esc="closeDesktopSearch"
          @keydown="handleKeydown"
        />
        <button
          v-if="searchQuery"
          type="button"
          @click="searchQuery = ''"
          class="absolute right-2 text-text-secondary hover:text-foreground text-xs p-0.5 cursor-pointer"
          title="清空"
        >
          <i class="fas fa-times-circle"></i>
        </button>
      </div>

      <div class="flex items-center gap-2 text-[11px] text-text-secondary flex-shrink-0">
        <!-- 匹配统计 -->
        <span
          v-if="searchQuery"
          class="px-1.5 py-0.5 rounded font-mono font-medium text-[11px]"
          :class="filteredFileList.length > 0 ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'"
        >
          {{ filteredFileList.length }} 项匹配
        </span>

        <!-- 关闭按钮（纯图标，无文字） -->
        <button
          type="button"
          @click="closeDesktopSearch"
          class="w-6 h-6 rounded flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 text-text-secondary hover:text-foreground transition-colors cursor-pointer"
          title="关闭搜索栏 (Esc)"
        >
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>
    </div>

    <!-- File List Viewport Wrapper (视口定位层，确保提示始终居中于可视区域) -->
    <div class="flex-grow min-h-0 relative overflow-hidden flex flex-col">
      <!-- 移动端专属流式卡片列表 -->
      <MobileFileManagerList
        v-if="props.isMobile"
        :items="filteredFileList"
        :is-loading="Boolean(currentSftpManager?.isLoading?.value)"
        :has-parent-link="hasParentLink"
        :current-path="currentSftpManager?.currentPath?.value ?? '/'"
        :search-query="searchQuery"
        :selected-items="selectedItems"
        :is-multi-select-mode="isMultiSelectMode"
        :is-compact="isCompactMode"
        :is-connected="Boolean(props.wsDeps.isConnected.value)"
        :has-clipboard-content="clipboardState.hasContent"
        :clipboard-operation="clipboardState.operation"
        :clipboard-count="clipboardSourcePaths.length"
        :clipboard-source-base-dir="clipboardSourceBaseDir"
        :double-click-to-open="fileManagerDoubleClickToOpenBoolean"
        @open-parent="handleGoParent"
        @item-click="(item) => handleItemAction(item)"
        @toggle-select="handleMobileToggleSelect"
        @open-action-sheet="handleOpenMobileActionSheet"
        @select-all="handleMobileSelectAll"
        @deselect-all="handleMobileDeselectAll"
        @batch-download="handleMobileBatchDownload"
        @batch-copy="handleMobileBatchCopy"
        @batch-cut="handleMobileBatchCut"
        @batch-paste="handleMobilePaste"
        @batch-delete="handleDeleteSelectedClick"
        @cancel-clipboard="clearClipboard"
        @exit-multi-select="() => { isMultiSelectMode = false; clearSelection(); }"
      />

      <!-- 桌面端表格视图与拖拽层 -->
      <template v-else>
        <div class="flex-1 min-h-0 flex relative overflow-hidden">
          <!-- 左侧纯目录树导航窗格 -->
          <DirectoryTree
            v-if="showDirectoryTree"
            :instance-id="props.instanceId"
            :current-path="currentSftpManager?.currentPath?.value ?? '/'"
            :is-connected="Boolean(props.wsDeps.isConnected.value)"
            :is-sftp-ready="Boolean(props.wsDeps.isSftpReady.value)"
            :sftp-manager="currentSftpManager"
            :width="directoryTreeWidth"
            :search-query="searchQuery"
            @select-directory="handleTreeSelectDirectory"
            @select-file="handleTreeSelectFile"
          />

          <!-- 拖拽调整宽度的竖线分割条 -->
          <div
            v-if="showDirectoryTree"
            class="w-1 bg-border/60 hover:bg-primary transition-colors cursor-col-resize z-20 flex-shrink-0"
            :class="{ 'bg-primary': isResizingTree }"
            @mousedown="startTreeResize"
          ></div>

          <!-- 右侧表格主体区域 -->
          <div class="flex-1 min-w-0 flex flex-col relative overflow-hidden">
            <!-- 跨窗格拖拽到当前目录的放置提示 (不受内部滚动条影响，吸附在视口正中) -->
            <div
              v-if="isContainerDropTarget"
              class="absolute inset-0 z-40 flex items-center justify-center bg-primary/10 pointer-events-none border-2 border-dashed border-primary/60 rounded-md backdrop-blur-[0.5px]"
            >
              <div class="px-3.5 py-1.5 rounded-lg bg-header/95 border border-primary/40 text-foreground text-xs font-medium shadow-xl flex items-center gap-2">
                <i class="fas fa-file-import text-primary animate-bounce"></i>
                <span>松开移动到当前目录</span>
              </div>
            </div>

            <!-- 桌面端列表固定表头栏 (独立于滚动条容器，横向 100% 满宽，右端绝不被滚动条截断) -->
            <div
              v-if="viewMode === 'list'"
              ref="tableHeaderContainerRef"
              class="w-full flex-shrink-0 bg-header border-b border-border select-none overflow-hidden"
              :style="{
                '--row-size-multiplier': rowSizeMultiplier,
                '--font-scale': `max(0.85, ${rowSizeMultiplier} * 0.5 + 0.5)`
              }"
            >
              <table class="w-full border-collapse table-fixed border-border">
                <colgroup>
                  <col v-for="colKey in columnOrder" :key="colKey" :style="{ width: `${colWidths[colKey]}px` }">
                </colgroup>
                <thead class="bg-header select-none">
                  <tr>
                    <th
                      v-for="(colKey, colIndex) in columnOrder"
                      :key="colKey"
                      :data-col-key="colKey"
                      @pointerdown="handleHeaderPointerDown($event, colKey, COLUMN_CONFIG_MAP[colKey].sortKey)"
                      class="group relative text-left text-xs font-medium text-text-secondary select-none whitespace-nowrap bg-header"
                      :class="[
                        COLUMN_CONFIG_MAP[colKey].sortKey ? 'cursor-pointer' : 'cursor-default',
                        isDraggingColumn && dragSourceCol === colKey ? 'opacity-40' : ''
                      ]"
                      :style="{
                        padding: colKey === 'type'
                          ? `calc(0.4rem * var(--row-size-multiplier)) calc(0.5rem * var(--row-size-multiplier)) calc(0.4rem * var(--row-size-multiplier)) calc(1rem * var(--row-size-multiplier))`
                          : `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`
                      }"
                    >
                      <!-- 拖拽重排插入指示竖线 (根据 dropPosition 显示在左侧或右侧) -->
                      <div
                        v-if="isDraggingColumn && dragOverCol === colKey && dragSourceCol !== colKey"
                        class="absolute top-0 bottom-0 w-0.5 bg-primary z-30 pointer-events-none"
                        :class="dropPosition === 'before' ? 'left-0' : 'right-0'"
                      ></div>

                      <div
                        class="inline-flex items-center gap-1.5 transition-colors group-hover:text-foreground"
                        :class="COLUMN_CONFIG_MAP[colKey].sortKey && sortKey === COLUMN_CONFIG_MAP[colKey].sortKey ? 'text-foreground' : 'text-text-secondary'"
                      >
                        <span>{{ t(COLUMN_CONFIG_MAP[colKey].labelKey) }}</span>
                        <span
                          v-if="COLUMN_CONFIG_MAP[colKey].sortKey"
                          class="inline-flex items-center text-[10px] transition-all duration-150"
                          :class="sortKey === COLUMN_CONFIG_MAP[colKey].sortKey ? 'text-primary opacity-100 scale-100' : 'text-text-secondary/40 opacity-0 group-hover:opacity-100 scale-90'"
                        >
                          <i
                            v-if="sortKey === COLUMN_CONFIG_MAP[colKey].sortKey"
                            class="fas"
                            :class="sortDirection === 'asc' ? 'fa-arrow-up-long' : 'fa-arrow-down-long'"
                          ></i>
                          <i
                            v-else
                            class="fas fa-sort"
                          ></i>
                        </span>
                      </div>

                      <!-- 列宽调整手柄 (不是最后一列时显示) -->
                      <div
                        v-if="colIndex < columnOrder.length - 1"
                        class="absolute top-1/2 -translate-y-1/2 right-0 w-2.5 h-full flex items-center justify-center cursor-col-resize z-20 group/resizer"
                        @mousedown.stop.prevent="startResize($event, colKey)"
                        @pointerdown.stop
                        @click.stop
                      >
                        <div class="w-px h-3 bg-border/40 group-hover/resizer:bg-primary group-hover/resizer:h-full transition-all duration-150"></div>
                      </div>
                    </th>
                  </tr>
                </thead>
              </table>
            </div>

            <!-- File List Container -->
            <div
              ref="fileListContainerRef"
              class="flex-grow min-h-0 overflow-y-auto relative outline-none transition-colors duration-150"
              :class="{ 'ring-2 ring-primary/60 ring-inset bg-primary/[0.03]': isContainerDropTarget }"
              @dragenter.prevent="handleDragEnter"
              @dragover.prevent="handleDragOver"
              @dragleave.prevent="handleDragLeave"
              @drop.prevent="handleDrop"
              @click="fileListContainerRef?.focus()"
              @keydown="handleKeydown"
              @wheel="handleWheel"
              @scroll="handleBodyScroll"
              @contextmenu.prevent="showContextMenu($event)"
              :style="{
                '--row-size-multiplier': rowSizeMultiplier,
                '--font-scale': `max(0.85, ${rowSizeMultiplier} * 0.5 + 0.5)`
              }"
              tabindex="0"
            >
              <!-- 外部文件拖拽蒙版 -->
              <div
                v-if="showExternalDropOverlay"
                ref="dropOverlayRef"
                class="absolute inset-0 flex items-center justify-center bg-black/70 text-white text-xl font-semibold rounded z-50 pointer-events-auto"
                @dragover.prevent
                @dragleave.prevent="handleDragLeave"
                @drop.prevent="handleOverlayDrop"
              >
                {{ t('fileManager.dropFilesHere', 'Drop files here to upload') }}
              </div>

              <!-- File Table (List View) -->
              <table v-if="viewMode === 'list'" ref="tableRef" class="w-full border-collapse table-fixed border-border rounded" :class="{'pointer-events-none': showExternalDropOverlay}" @contextmenu.prevent>
                  <colgroup>
                      <col v-for="colKey in columnOrder" :key="colKey" :style="{ width: `${colWidths[colKey]}px` }">
                 </colgroup>

          <!-- 首次冷启动加载状态 (在未完成加载或加载进行中且列表完全为空时展示，避免闪烁中间态) -->
          <tbody v-if="(!currentSftpManager || !currentSftpManager.initialLoadDone.value || currentSftpManager.isLoading.value) && filteredFileList.length === 0">
              <tr>
                  <td :colspan="columnOrder.length" class="px-4 py-16 text-center">
                    <div class="inline-flex flex-col items-center justify-center gap-2.5 text-text-secondary">
                      <i class="fas fa-circle-notch fa-spin text-xl text-primary"></i>
                      <span class="text-xs font-medium">{{ t('fileManager.loading', '正在加载文件列表...') }}</span>
                    </div>
                  </td>
              </tr>
          </tbody>

          <!-- 正常文件列表渲染 (切换与进入文件夹时保留原有条目，绝不整体消失) -->
          <tbody
            v-else
            :class="{
              'pointer-events-none': currentSftpManager?.isLoading.value
            }"
          >
            <!-- '..' Entry (固定顶部，直观返回：只要当前不是根目录，即便空文件夹也常驻保留) -->
            <tr v-if="hasParentLink"
                class="transition-colors duration-150 cursor-pointer select-none"
                :class="{
                    'bg-primary/10': navigatingTargetName === '..' || selectedIndex === 0,
                    'outline-dashed outline-2 outline-offset-[-1px] outline-primary': dragOverTarget === '..',
                    'hover:bg-header/50': dragOverTarget !== '..' && navigatingTargetName !== '..'
                }"
                @click="handleItemClick($event, { filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } })"
                @dblclick="handleItemDoubleClick($event, { filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } })"
                @contextmenu.prevent.stop="showContextMenu($event, { filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } })"
                @dragover.prevent="handleDragOverRow({ filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } }, $event)"
                @dragleave="handleDragLeaveRow({ filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } })"
                @drop.prevent="handleDropOnRow({ filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } }, $event)"
                :data-filename="'..'"
                >
              <template v-for="colKey in columnOrder" :key="colKey">
                <td v-if="colKey === 'type'" class="text-center border-b border-border/30 align-middle" :style="{ paddingLeft: `calc(1rem * var(--row-size-multiplier))`, paddingRight: `calc(0.5rem * var(--row-size-multiplier))` }">
                  <i
                    v-if="navigatingTargetName === '..'"
                    class="fas fa-circle-notch fa-spin text-primary fa-fw"
                    :style="{ fontSize: `calc(1.1em * var(--font-scale))` }"
                  ></i>
                  <i
                    v-else
                    class="fas fa-level-up-alt text-primary fa-fw"
                    :style="{ fontSize: `calc(1.1em * var(--font-scale))` }"
                  ></i>
                </td>
                <td v-else-if="colKey === 'name'" class="border-b border-border/30 align-middle" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.8rem * var(--font-scale))` }">..</td>
                <td v-else class="border-b border-border/30 align-middle"></td>
              </template>
            </tr>

            <!-- Empty Directory / No Search Results Row (空文件夹或搜索无结果时在 .. 之下展示提示，严格确保在非加载状态下展示) -->
            <tr v-if="!currentSftpManager?.isLoading.value && filteredFileList.length === 0">
              <td :colspan="columnOrder.length" class="px-4 py-8 text-center text-text-secondary italic">
                {{ searchQuery ? t('fileManager.noSearchResults') : t('fileManager.emptyDirectory') }}
              </td>
            </tr>

            <!-- File Entries (虚拟切片渲染) -->
            <template v-else>
              <!-- 虚拟滚动顶部垫片行 -->
              <tr v-if="topPadding > 0" :style="{ height: `${topPadding}px` }">
                <td :colspan="columnOrder.length" class="p-0 border-0 pointer-events-none"></td>
              </tr>

              <tr v-for="({ item, index }) in visibleItems"
                  :key="item.filename"
                  :draggable="item.filename !== '..'" @dragstart="handleDragStart(item, $event)" @dragend="handleDragEnd"
                  @click="handleItemClick($event, item, props.isMobile && isMultiSelectMode)"
                  @dblclick="handleItemDoubleClick($event, item)"
                  class="transition-colors duration-150 select-none"
                  :class="[
                      { 'cursor-pointer': item.attrs.isDirectory || item.attrs.isFile },
                      navigatingTargetName === item.filename
                        ? 'bg-primary/10 text-foreground'
                        : (selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex))
                          ? 'bg-primary text-white'
                          : 'hover:bg-header/50',
                      { 'outline-dashed outline-2 outline-offset-[-1px] outline-primary': item.attrs.isDirectory && dragOverTarget === item.filename }
                  ]"
                 :data-filename="item.filename"
                 @contextmenu.prevent.stop="showContextMenu($event, item)"
                 @dragover.prevent="handleDragOverRow(item, $event)"
                 @dragleave="handleDragLeaveRow(item)"
                 @drop.prevent="handleDropOnRow(item, $event)">
                <template v-for="colKey in columnOrder" :key="colKey">
                  <td v-if="colKey === 'type'" class="text-center border-b border-border/30 align-middle" :style="{ paddingLeft: `calc(1rem * var(--row-size-multiplier))`, paddingRight: `calc(0.5rem * var(--row-size-multiplier))` }">
                    <i
                      v-if="navigatingTargetName === item.filename"
                      class="fas fa-circle-notch fa-spin text-primary fa-fw"
                      :style="{ fontSize: `calc(1.1em * var(--font-scale))` }"
                    ></i>
                    <i
                      v-else
                      :class="[
                        'fa-fw transition-colors duration-150',
                        item.attrs.isDirectory
                          ? 'fas fa-folder text-primary'
                          : item.attrs.isSymbolicLink
                            ? 'fas fa-link text-cyan-500'
                            : `${getFileIconClass(item.filename)} text-text-secondary`,
                        {
                          'text-white': navigatingTargetName !== item.filename && (selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex))
                        }
                      ]"
                      :style="{ fontSize: `calc(1.1em * var(--font-scale))` }"></i>
                  </td>
                  <td v-else-if="colKey === 'name'" class="border-b border-border/30 truncate align-middle" :class="{'font-medium': item.attrs.isDirectory}" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.8rem * var(--font-scale))` }">{{ item.filename }}</td>
                  <td v-else-if="colKey === 'size'" class="border-b border-border/30 truncate align-middle" :class="[
                    selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex) ? 'text-white' : 'text-text-secondary'
                  ]" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.72rem * var(--font-scale))` }">{{ item.attrs.isFile ? formatFileSize(item.attrs.size) : '' }}</td> 
                  <td v-else-if="colKey === 'permissions'" class="border-b border-border/30 truncate font-mono align-middle" :class="[
                    selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex) ? 'text-white' : 'text-text-secondary'
                  ]" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.72rem * var(--font-scale))` }">{{ formatFileMode(item.attrs.mode) }}</td>
                  <td v-else-if="colKey === 'modified'" class="border-b border-border/30 truncate align-middle" :class="[
                    selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex) ? 'text-white' : 'text-text-secondary'
                  ]" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.72rem * var(--font-scale))` }">{{ formatFileDate(item.attrs.mtime) }}</td> 
                </template>
              </tr>

              <!-- 虚拟滚动底部垫片行 -->
              <tr v-if="bottomPadding > 0" :style="{ height: `${bottomPadding}px` }">
                <td :colspan="columnOrder.length" class="p-0 border-0 pointer-events-none"></td>
              </tr>
            </template>
          </tbody>
        </table>

        <!-- 平铺视图 (Tile View) -->
        <div
          v-else-if="viewMode === 'tile'"
          class="p-3 min-h-full select-none"
          :class="{'pointer-events-none': showExternalDropOverlay}"
          @contextmenu.prevent
        >
          <!-- 首次冷启动加载状态 (在未完成加载或加载进行中且列表完全为空时展示，避免闪烁中间态) -->
          <div
            v-if="(!currentSftpManager || !currentSftpManager.initialLoadDone.value || currentSftpManager.isLoading.value) && filteredFileList.length === 0"
            class="py-16 text-center"
          >
            <div class="inline-flex flex-col items-center justify-center gap-2.5 text-text-secondary">
              <i class="fas fa-circle-notch fa-spin text-xl text-primary"></i>
              <span class="text-xs font-medium">{{ t('fileManager.loading', '正在加载文件列表...') }}</span>
            </div>
          </div>

          <!-- 平铺网格卡片容器 -->
          <div
            v-else
            class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2"
            :class="{
              'pointer-events-none': currentSftpManager?.isLoading.value
            }"
          >
            <!-- '..' Entry 返回上一级 -->
            <div
              v-if="hasParentLink"
              class="group flex items-center gap-2.5 px-2.5 py-1.5 h-[52px] rounded-lg border transition-all duration-150 cursor-pointer select-none"
              :class="[
                navigatingTargetName === '..' || selectedIndex === 0
                  ? 'bg-primary/10 border-primary/50 text-foreground'
                  : 'bg-header/40 hover:bg-header/80 border-border/60 hover:border-border text-foreground',
                { 'outline-dashed outline-2 outline-offset-[-1px] outline-primary': dragOverTarget === '..' }
              ]"
              @click="handleItemClick($event, parentDirectoryItem)"
              @dblclick="handleItemDoubleClick($event, parentDirectoryItem)"
              @contextmenu.prevent.stop="showContextMenu($event, parentDirectoryItem)"
              @dragover.prevent="handleDragOverRow(parentDirectoryItem, $event)"
              @dragleave="handleDragLeaveRow(parentDirectoryItem)"
              @drop.prevent="handleDropOnRow(parentDirectoryItem, $event)"
              :data-filename="'..'"
            >
              <div class="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0 text-primary">
                <i
                  v-if="navigatingTargetName === '..'"
                  class="fas fa-circle-notch fa-spin text-base"
                ></i>
                <i
                  v-else
                  class="fas fa-level-up-alt text-base"
                ></i>
              </div>
              <div class="flex-1 min-w-0 flex flex-col justify-center">
                <div class="text-xs font-medium leading-snug truncate">..</div>
                <div class="text-[11px] text-text-secondary/75 leading-tight truncate">
                  {{ t('fileManager.actions.parentDirectory', '上一级') }}
                </div>
              </div>
            </div>

            <!-- 空文件夹或无搜索结果提示 (严格确保在非加载状态下展示) -->
            <div
              v-if="!currentSftpManager?.isLoading.value && filteredFileList.length === 0"
              class="col-span-full py-12 text-center text-text-secondary italic text-xs"
            >
              {{ searchQuery ? t('fileManager.noSearchResults') : t('fileManager.emptyDirectory') }}
            </div>

            <!-- 正常文件与文件夹卡片 -->
            <template v-else>
              <div
                v-for="(item, index) in filteredFileList"
                :key="item.filename"
                :draggable="item.filename !== '..'"
                @dragstart="handleDragStart(item, $event)"
                @dragend="handleDragEnd"
                @click="handleItemClick($event, item, props.isMobile && isMultiSelectMode)"
                @dblclick="handleItemDoubleClick($event, item)"
                @contextmenu.prevent.stop="showContextMenu($event, item)"
                @dragover.prevent="handleDragOverRow(item, $event)"
                @dragleave="handleDragLeaveRow(item)"
                @drop.prevent="handleDropOnRow(item, $event)"
                class="group flex items-center gap-2.5 px-2.5 py-1.5 h-[52px] rounded-lg border transition-all duration-150 select-none"
                :class="[
                  { 'cursor-pointer': item.attrs.isDirectory || item.attrs.isFile },
                  navigatingTargetName === item.filename
                    ? 'bg-primary/10 border-primary/50 text-foreground'
                    : (selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex))
                      ? 'bg-primary text-white border-primary shadow-sm ring-1 ring-primary/40'
                      : 'bg-header/40 hover:bg-header/80 border-border/60 hover:border-border text-foreground',
                  { 'outline-dashed outline-2 outline-offset-[-1px] outline-primary': item.attrs.isDirectory && dragOverTarget === item.filename }
                ]"
                :data-filename="item.filename"
                :title="item.filename"
              >
                <!-- 左侧大图标容器 -->
                <div
                  class="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 transition-colors duration-150"
                  :class="[
                    (selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex)) && navigatingTargetName !== item.filename
                      ? 'bg-white/20 text-white'
                      : item.attrs.isDirectory
                        ? 'bg-amber-500/15 text-amber-500'
                        : item.attrs.isSymbolicLink
                          ? 'bg-cyan-500/15 text-cyan-500'
                          : 'bg-black/5 dark:bg-white/5'
                  ]"
                >
                  <i
                    v-if="navigatingTargetName === item.filename"
                    class="fas fa-circle-notch fa-spin text-base text-primary"
                  ></i>
                  <i
                    v-else
                    class="text-base"
                    :class="[
                      item.attrs.isDirectory
                        ? 'fas fa-folder text-amber-500'
                        : item.attrs.isSymbolicLink
                          ? 'fas fa-link text-cyan-500'
                          : `${getFileIconClass(item.filename)} text-text-secondary`,
                      (selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex)) && navigatingTargetName !== item.filename
                        ? '!text-white'
                        : ''
                    ]"
                  ></i>
                </div>

                <!-- 右侧双行信息 -->
                <div class="flex-1 min-w-0 flex flex-col justify-center">
                  <!-- 文件名 -->
                  <div
                    class="text-xs leading-snug truncate"
                    :class="[
                      item.attrs.isDirectory ? 'font-medium' : 'font-normal',
                      (selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex)) && navigatingTargetName !== item.filename
                        ? 'text-white'
                        : 'text-foreground'
                    ]"
                  >
                    {{ item.filename }}
                  </div>

                  <!-- 文件属性/大小与修改时间 -->
                  <div
                    class="text-[11px] leading-tight truncate mt-0.5 flex items-center gap-1.5"
                    :class="[
                      (selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex)) && navigatingTargetName !== item.filename
                        ? 'text-white/80'
                        : 'text-text-secondary'
                    ]"
                  >
                    <span v-if="item.attrs.isDirectory">
                      {{ t('fileManager.headers.directory', '文件夹') }}
                    </span>
                    <span v-else-if="item.attrs.isFile">
                      {{ formatFileSize(item.attrs.size) }}
                    </span>
                    <span v-else-if="item.attrs.isSymbolicLink">
                      {{ t('fileManager.headers.symbolicLink', '快捷方式') }}
                    </span>
                    <span class="opacity-40 text-[9px]">·</span>
                    <span class="opacity-75 text-[10px]">{{ formatFileDate(item.attrs.mtime) }}</span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
        <!-- Removed separate loading/empty divs -->
      </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 表头列拖拽浮动徽章跟随鼠标 -->
    <Teleport to="body">
      <div
        v-if="isDraggingColumn && dragSourceCol"
        class="fixed pointer-events-none z-[9999] px-2.5 py-1 rounded bg-primary text-white text-xs font-medium shadow-xl flex items-center gap-1.5 opacity-90 -translate-x-1/2 -translate-y-1/2 select-none"
        :style="{ left: `${dragMouseX}px`, top: `${dragMouseY}px` }"
      >
        <i class="fas fa-arrows-alt-h text-[10px] opacity-75"></i>
        <span>{{ t(COLUMN_CONFIG_MAP[dragSourceCol].labelKey) }}</span>
      </div>
    </Teleport>

     <!-- 使用 FileUploadPopup 组件 -->
     <FileUploadPopup :uploads="uploads" @cancel-upload="cancelUpload" />

    <FileManagerContextMenu
      ref="contextMenuRef"
      :is-visible="contextMenuVisible"
      :position="contextMenuPosition"
      :items="contextMenuItems"
      :active-context-item="contextTargetItem"
      :selected-file-items="computedSelectedFullItems"
      :current-directory-path="currentSftpManager?.currentPath?.value ?? '/'"
     @close-request="hideContextMenu"
   />

   <!-- Action Modal -->
   <FileManagerActionModal
     :is-visible="isActionModalVisible"
     :action-type="currentActionType"
     :item="actionItem"
     :items="actionItems"
     :initial-value="actionInitialValue"
     :is-mobile="props.isMobile"
     @close="handleModalClose"
     @confirm="handleModalConfirm"
   />

   <!-- Favorite Paths Modal is now positioned near its button -->

    <!-- 移动端专属文件操作抽屉 -->
    <MobileFileActionSheet
      v-if="props.isMobile"
      :is-visible="showMobileActionSheet"
      :item="activeMobileActionItem"
      :current-path="currentSftpManager?.currentPath?.value ?? '/'"
      :is-connected="Boolean(props.wsDeps.isConnected.value)"
      @close="handleCloseMobileActionSheet"
      @open-file="(item) => handleItemAction(item)"
      @download="(item) => triggerDownload([item])"
      @download-dir="(item) => triggerDownloadDirectory(item)"
      @rename="(item) => handleRenameContextMenuClick(item)"
      @copy="handleMobileSingleCopy"
      @cut="handleMobileSingleCut"
      @delete="handleMobileSingleDelete"
      @chmod="(item) => handleChangePermissionsContextMenuClick(item)"
      @cd-terminal="handleMobileCdTerminal"
    />

</div>
</template>

<style scoped>
/* Scoped styles removed for Tailwind CSS refactoring */
</style>


