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
import FileUploadPopup from './FileUploadPopup.vue';
import FileManagerContextMenu from './FileManagerContextMenu.vue';
import FileManagerActionModal from './FileManagerActionModal.vue';
import FileManagerHeader from './FileManagerHeader.vue';
import FileManagerBreadcrumbs from './FileManagerBreadcrumbs.vue';
import type { FileListItem } from '../types/sftp.types';
import type { WebSocketMessage } from '../types/websocket.types';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { getFileIconClass } from '../utils/fileIcons';
import { formatFileSize, formatFileMode, formatFileDate } from '../utils/fileFormatters';


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
 
// 从 Settings Store 获取共享设置
const {
  shareFileEditorTabsBoolean,
  fileManagerRowSizeMultiplierNumber,
  fileManagerColWidthsObject,
  showPopupFileEditorBoolean,
  fileManagerShowDeleteConfirmationBoolean,
} = storeToRefs(settingsStore);

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
  clearSelection, // 获取清空选择的方法
} = useFileManagerSelection({
  // 传递当前显示的列表 (已排序和过滤)
  displayedFileList: filteredFileList, // 现在 filteredFileList 已定义
  onItemAction: handleItemAction, // 传递动作回调
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
} = useFileManagerVirtualScroll({
  items: filteredFileList,
  containerRef: fileListContainerRef,
  rowSizeMultiplier,
  hasParentLink,
});

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
    if (hasParentLink.value) {
      if (index === 0) {
        if (fileListContainerRef.value) fileListContainerRef.value.scrollTop = 0;
      } else {
        virtualScrollToIndex(index - 1);
      }
    } else {
      virtualScrollToIndex(index);
    }
  },
});


// 监听 manager 的 currentPath：路径更换时自动重置选择和清空搜索栏
watch(() => currentSftpManager.value?.currentPath.value, (newPath, oldPath) => {
    selectedIndex.value = -1;
    clearSelection();
    // 当识别到更换了路径后，自动清空搜索栏并收起搜索状态
    if (newPath !== oldPath) {
        searchQuery.value = '';
        isSearchActive.value = false;
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
    // --- 移除 onMounted 中的加载逻辑 ---
    // Initial load logic is handled by watchEffect below and the main sftp loading watchEffect
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

    // 修改：添加 ?. 访问 isLoading, 检查 manager 的 initialLoadDone
    // 只有在连接就绪、SFTP 就绪、管理器存在、未加载且 initialLoadDone 为 false 时才获取初始路径
    if (currentSftpManager.value && props.wsDeps.isConnected.value && props.wsDeps.isSftpReady.value && !currentSftpManager.value.isLoading.value && !currentSftpManager.value.initialLoadDone.value) {
        console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Connection ready for manager, fetching initial path for the first time (isLoading: ${currentSftpManager.value.isLoading.value}, initialLoadDone: ${currentSftpManager.value.initialLoadDone.value}).`);
        // isFetchingInitialPath 状态移除, 使用 isLoading 状态

        // 仍然使用 props.wsDeps 中的 sendMessage 和 onMessage
        const { sendMessage: wsSend, onMessage: wsOnMessage } = props.wsDeps;
        const requestId = generateRequestId(); // 使用本地辅助函数
        const requestedPath = '.';

        unregisterSuccess = wsOnMessage('sftp:realpath:success', (payload: any, message: WebSocketMessage) => { // message 已有类型
            if (message.requestId === requestId && payload.requestedPath === requestedPath) {
                // 修改：检查 currentSftpManager 是否存在
                if (!currentSftpManager.value) return;
                const absolutePath = payload.absolutePath;
                console.log(`[FileManager ${props.sessionId}-${props.instanceId}] Received initial absolute path for '.': ${absolutePath}. Loading directory.`);
                // 修改：添加 ?. 访问 loadDirectory 和 setInitialLoadDone
                currentSftpManager.value?.loadDirectory(absolutePath);
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

// +++ 注册/注销自定义聚焦动作 +++
let unregisterSearchFocusAction: (() => void) | null = null;
let unregisterPathFocusAction: (() => void) | null = null;

let unregisterItemsMovedEvent: (() => void) | null = null;

onMounted(() => {
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
  if (unregisterItemsMovedEvent) {
    unregisterItemsMovedEvent();
    unregisterItemsMovedEvent = null;
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

// +++ 暴露给外部与焦点切换器的操作 +++
const focusSearchInput = (): boolean => {
  if (props.sessionId !== sessionStore.activeSessionId) {
    return false;
  }
  return headerRef.value?.focusSearchInput() ?? false;
};

const startPathEdit = () => {
  if (props.sessionId === sessionStore.activeSessionId) {
    breadcrumbsRef.value?.startEdit();
  }
};

defineExpose({ focusSearchInput, startPathEdit });
</script>

<template>
  <div class="flex flex-col h-full min-h-0 overflow-hidden bg-background text-foreground text-sm font-sans">
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
      :show-popup-file-editor="showPopupFileEditorBoolean"
      v-model:search-query="searchQuery"
      v-model:is-search-active="isSearchActive"
      @cd-to-terminal="sendCdCommandToTerminal"
      @open-popup-editor="openPopupEditor"
      @upload-files="triggerFileUpload"
      @new-folder="handleNewFolderContextMenuClick"
      @new-file="handleNewFileContextMenuClick"
      @toggle-multi-select="toggleMultiSelectMode"
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


    <!-- File List Container -->
    <div
      ref="fileListContainerRef"
      class="flex-grow min-h-0 overflow-y-auto relative outline-none [scrollbar-gutter:stable] transition-colors duration-150"
      :class="{ 'ring-2 ring-primary/60 ring-inset bg-primary/[0.03]': isContainerDropTarget }"
      @dragenter.prevent="handleDragEnter"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="handleDrop"
      @click="fileListContainerRef?.focus()"
      @keydown="handleKeydown"
      @wheel="handleWheel"
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

        <!-- 跨窗格拖拽到当前目录的放置提示 -->
        <div
          v-if="isContainerDropTarget"
          class="absolute inset-0 z-40 flex items-center justify-center bg-primary/10 pointer-events-none border-2 border-dashed border-primary/60 rounded-md backdrop-blur-[0.5px]"
        >
          <div class="px-3.5 py-1.5 rounded-lg bg-header/95 border border-primary/40 text-foreground text-xs font-medium shadow-xl flex items-center gap-2">
            <i class="fas fa-file-import text-primary animate-bounce"></i>
            <span>松开移动到当前目录</span>
          </div>
        </div>

        <!-- File Table -->
        <table ref="tableRef" class="w-full border-collapse table-fixed border-border rounded" :class="{'pointer-events-none': showExternalDropOverlay}" @contextmenu.prevent>
            <colgroup>
                 <col :style="{ width: `${colWidths.type}px` }">
                <col :style="{ width: `${colWidths.name}px` }">
                <col :style="{ width: `${colWidths.size}px` }">
                <col :style="{ width: `${colWidths.permissions}px` }">
                <col :style="{ width: `${colWidths.modified}px` }">
           </colgroup>
          <thead class="sticky top-0 z-10 bg-header select-none">
            <tr>
              <th
                @click="handleSort('type')"
                class="relative px-2 py-1 border-b-2 border-border text-left text-xs font-medium text-text-secondary uppercase tracking-wider cursor-pointer select-none hover:bg-black/5 whitespace-nowrap"
                :style="{ paddingLeft: `calc(1rem * var(--row-size-multiplier))`, paddingRight: `calc(0.5rem * var(--row-size-multiplier))` }"
              >
                {{ t('fileManager.headers.type') }}
                <span v-if="sortKey === 'type'" class="ml-1">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
                <span class="absolute top-0 right-[-3px] w-1.5 h-full cursor-col-resize z-20 hover:bg-primary/20" @mousedown.prevent="startResize($event, 0)" @click.stop></span>
              </th>
              <th
                @click="handleSort('filename')"
                class="relative px-2 py-1 border-b-2 border-border text-left text-xs font-medium text-text-secondary uppercase tracking-wider cursor-pointer select-none hover:bg-black/5 whitespace-nowrap"
                :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))` }"
              >
                {{ t('fileManager.headers.name') }}
                <span v-if="sortKey === 'filename'" class="ml-1">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
                <span class="absolute top-0 right-[-3px] w-1.5 h-full cursor-col-resize z-20 hover:bg-primary/20" @mousedown.prevent="startResize($event, 1)" @click.stop></span>
              </th>
              <th
                @click="handleSort('size')"
                class="relative px-2 py-1 border-b-2 border-border text-left text-xs font-medium text-text-secondary uppercase tracking-wider cursor-pointer select-none hover:bg-black/5 whitespace-nowrap"
                :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))` }"
              >
                {{ t('fileManager.headers.size') }}
                <span v-if="sortKey === 'size'" class="ml-1">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
                <span class="absolute top-0 right-[-3px] w-1.5 h-full cursor-col-resize z-20 hover:bg-primary/20" @mousedown.prevent="startResize($event, 2)" @click.stop></span>
              </th>
              <th
                class="relative px-2 py-1 border-b-2 border-border text-left text-xs font-medium text-text-secondary uppercase tracking-wider select-none whitespace-nowrap"
                :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))` }"
              >
                {{ t('fileManager.headers.permissions') }}
                <span class="absolute top-0 right-[-3px] w-1.5 h-full cursor-col-resize z-20 hover:bg-primary/20" @mousedown.prevent="startResize($event, 3)" @click.stop></span>
              </th>
              <th
                @click="handleSort('mtime')"
                class="relative px-2 py-1 border-b-2 border-border text-left text-xs font-medium text-text-secondary uppercase tracking-wider cursor-pointer select-none hover:bg-black/5 whitespace-nowrap"
                :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))` }"
              >
                {{ t('fileManager.headers.modified') }}
                <span v-if="sortKey === 'mtime'" class="ml-1">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
                <!-- No resizer on the last column -->
              </th>
            </tr>
          </thead>

          <!-- Loading State -->
          <tbody v-if="!currentSftpManager || currentSftpManager.isLoading.value">
              <tr>
                  <td :colspan="5" class="px-4 py-6 text-center text-text-secondary italic">
                    {{ t('fileManager.loading') }}
                  </td>
              </tr>
          </tbody>

          <!-- File List State -->
          <tbody v-else>
            <!-- '..' Entry (固定顶部，直观返回：只要当前不是根目录，即便空文件夹也常驻保留) -->
            <tr v-if="hasParentLink"
                class="transition-colors duration-150 cursor-pointer select-none"
                :class="{
                    'bg-primary/10': selectedIndex === 0,
                    'outline-dashed outline-2 outline-offset-[-1px] outline-primary': dragOverTarget === '..',
                    'hover:bg-header/50': dragOverTarget !== '..'
                }"
                @click="handleItemClick($event, { filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } })"
                @contextmenu.prevent.stop="showContextMenu($event, { filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } })"
                @dragover.prevent="handleDragOverRow({ filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } }, $event)"
                @dragleave="handleDragLeaveRow({ filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } })"
                @drop.prevent="handleDropOnRow({ filename: '..', longname: '..', attrs: { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, uid: 0, gid: 0, mode: 0, atime: 0, mtime: 0 } }, $event)"
                :data-filename="'..'"
                >
              <td class="text-center border-b border-border align-middle" :style="{ paddingLeft: `calc(1rem * var(--row-size-multiplier))`, paddingRight: `calc(0.5rem * var(--row-size-multiplier))` }">
                <i class="fas fa-level-up-alt text-primary" :style="{ fontSize: `calc(1.1em * var(--font-scale))` }"></i>
              </td>
              <td class="border-b border-border align-middle" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.8rem * var(--font-scale))` }">..</td>
              <td class="border-b border-border align-middle"></td>
              <td class="border-b border-border align-middle"></td>
              <td class="border-b border-border align-middle"></td>
            </tr>

            <!-- Empty Directory / No Search Results Row (空文件夹或搜索无结果时在 .. 之下展示提示) -->
            <tr v-if="filteredFileList.length === 0">
              <td :colspan="5" class="px-4 py-8 text-center text-text-secondary italic">
                {{ searchQuery ? t('fileManager.noSearchResults') : t('fileManager.emptyDirectory') }}
              </td>
            </tr>

            <!-- File Entries (虚拟切片渲染) -->
            <template v-else>
              <!-- 虚拟滚动顶部垫片行 -->
              <tr v-if="topPadding > 0" :style="{ height: `${topPadding}px` }">
                <td :colspan="5" class="p-0 border-0 pointer-events-none"></td>
              </tr>

              <tr v-for="({ item, index }) in visibleItems"
                  :key="item.filename"
                  :draggable="item.filename !== '..'" @dragstart="handleDragStart(item, $event)" @dragend="handleDragEnd"
                  @click="handleItemClick($event, item, props.isMobile && isMultiSelectMode)"
                  class="transition-colors duration-150 select-none"
                  :class="[
                      { 'cursor-pointer': item.attrs.isDirectory || item.attrs.isFile },
                      { 'bg-primary text-white': selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex) },
                      { 'hover:bg-header/50': !(selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex)) },
                      { 'outline-dashed outline-2 outline-offset-[-1px] outline-primary': item.attrs.isDirectory && dragOverTarget === item.filename }
                  ]"
                 :data-filename="item.filename"
                 @contextmenu.prevent.stop="showContextMenu($event, item)"
                 @dragover.prevent="handleDragOverRow(item, $event)"
                 @dragleave="handleDragLeaveRow(item)"
                 @drop.prevent="handleDropOnRow(item, $event)">
                <td class="text-center border-b border-border align-middle" :style="{ paddingLeft: `calc(1rem * var(--row-size-multiplier))`, paddingRight: `calc(0.5rem * var(--row-size-multiplier))` }">
                  <i :class="[
                    'transition-colors duration-150',
                    item.attrs.isDirectory
                      ? 'fas fa-folder text-primary'
                      : item.attrs.isSymbolicLink
                        ? 'fas fa-link text-cyan-500'
                        : `${getFileIconClass(item.filename)} text-text-secondary`,
                    {
                      'text-white': selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex)
                    }
                  ]"
                  :style="{ fontSize: `calc(1.1em * var(--font-scale))` }"></i>
                </td>
                <td class="border-b border-border truncate align-middle" :class="{'font-medium': item.attrs.isDirectory}" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.8rem * var(--font-scale))` }">{{ item.filename }}</td>
                <td class="border-b border-border truncate align-middle" :class="[
                  selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex) ? 'text-white' : 'text-text-secondary'
                ]" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.72rem * var(--font-scale))` }">{{ item.attrs.isFile ? formatFileSize(item.attrs.size) : '' }}</td> 
                <td class="border-b border-border truncate font-mono align-middle" :class="[
                  selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex) ? 'text-white' : 'text-text-secondary'
                ]" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.72rem * var(--font-scale))` }">{{ formatFileMode(item.attrs.mode) }}</td>
                <td class="border-b border-border truncate align-middle" :class="[
                  selectedItems.has(item.filename) || (index + (hasParentLink ? 1 : 0) === selectedIndex) ? 'text-white' : 'text-text-secondary'
                ]" :style="{ padding: `calc(0.4rem * var(--row-size-multiplier)) calc(0.8rem * var(--row-size-multiplier))`, fontSize: `calc(0.72rem * var(--font-scale))` }">{{ formatFileDate(item.attrs.mtime) }}</td> 
              </tr>

              <!-- 虚拟滚动底部垫片行 -->
              <tr v-if="bottomPadding > 0" :style="{ height: `${bottomPadding}px` }">
                <td :colspan="5" class="p-0 border-0 pointer-events-none"></td>
              </tr>
            </template>
          </tbody>
        </table>
        <!-- Removed separate loading/empty divs -->
     </div>

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
     @close="handleModalClose"
     @confirm="handleModalConfirm"
   />

  <!-- Favorite Paths Modal is now positioned near its button -->


</div>
</template>

<style scoped>
/* Scoped styles removed for Tailwind CSS refactoring */
</style>


