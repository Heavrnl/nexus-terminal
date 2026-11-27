<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onDeactivated, onBeforeUnmount, watch, nextTick } from 'vue';
import AddConnectionForm from '../components/AddConnectionForm.vue';
import BatchEditConnectionForm from '../components/BatchEditConnectionForm.vue';
import ColorPickerPopover from '../components/common/ColorPickerPopover.vue';
import { hexToRgba, resolveEffectiveColor } from '../utils/colorUtils';
import { useConnectionsStore } from '../stores/connections.store';
import { useSessionStore } from '../stores/session.store';
import { useFoldersStore, type FolderInfo } from '../stores/folders.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import type { SortField, SortOrder } from '../stores/settings.store';
import { useI18n } from 'vue-i18n';
import type { ConnectionInfo } from '../stores/connections.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog';
import { storeToRefs } from 'pinia';
import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS, ja } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import AppSelect from '../components/common/AppSelect.vue';
import { getFolderMoveMenuPosition } from '../utils/folderMoveMenuPosition';

const { t, locale } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog();
const connectionsStore = useConnectionsStore();
const sessionStore = useSessionStore();
const foldersStore = useFoldersStore();
const uiNotificationsStore = useUiNotificationsStore();

const { connections, isLoading: isLoadingConnections } = storeToRefs(connectionsStore);
const { folders: folders, isLoading: isLoadingFolders } = storeToRefs(foldersStore);

const LS_SORT_BY_KEY = 'connections_view_sort_by';
const LS_SORT_ORDER_KEY = 'connections_view_sort_order';
const LS_ACTIVE_FOLDER_KEY = 'connections_view_active_folder';

const localSortBy = ref<SortField>(localStorage.getItem(LS_SORT_BY_KEY) as SortField || 'last_connected_at');
const localSortOrder = ref<SortOrder>(localStorage.getItem(LS_SORT_ORDER_KEY) as SortOrder || 'desc');

// 当前激活的文件夹：'all' | 'uncategorized' | number
type ActiveFolderType = 'all' | 'uncategorized' | number;
const getInitialActiveFolder = (): ActiveFolderType => {
  const stored = localStorage.getItem(LS_ACTIVE_FOLDER_KEY);
  if (!stored || stored === 'all') return 'all';
  if (stored === 'uncategorized') return 'uncategorized';
  const parsed = parseInt(stored, 10);
  return isNaN(parsed) ? 'all' : parsed;
};
const activeFolder = ref<ActiveFolderType>(getInitialActiveFolder());
const searchQuery = ref('');

// 文件夹行内编辑与新建状态
const isCreatingFolder = ref(false);
const newFolderName = ref('');
const newFolderInputRef = ref<HTMLInputElement | null>(null);

const editingFolderId = ref<number | null>(null);
const editingFolderName = ref('');
const editFolderInputRef = ref<HTMLInputElement | null>(null);

// 文件夹背景色拾色器浮层状态
const activeColorPickerFolderId = ref<number | null>(null);
const activeColorPickerTriggerEl = ref<HTMLElement | null>(null);

const toggleFolderColorPicker = (folderId: number, e: Event) => {
  e.stopPropagation();
  if (activeColorPickerFolderId.value === folderId) {
    activeColorPickerFolderId.value = null;
    activeColorPickerTriggerEl.value = null;
  } else {
    activeColorPickerFolderId.value = folderId;
    activeColorPickerTriggerEl.value = (e.currentTarget as HTMLElement) || (e.target as HTMLElement);
  }
};

const handleSaveFolderColor = async (folderId: number, color: string | null) => {
  await foldersStore.updateFolderColor(folderId, color);
  uiNotificationsStore.showSuccess(t('folders.colorUpdated', '文件夹背景颜色已更新'));
  activeColorPickerFolderId.value = null;
  activeColorPickerTriggerEl.value = null;
};

// 拖拽状态
const draggedConnectionId = ref<number | null>(null);
const dragOverFolderId = ref<ActiveFolderType | null>(null);

// 单项及批量移至文件夹共用一个脱离卡片/工具栏的浮层。
const activeMoveMenu = ref<number | 'batch' | null>(null);
const moveMenuAnchor = shallowRef<HTMLElement | null>(null);
const moveMenuRef = ref<HTMLElement | null>(null);
const moveMenuStyle = ref<Record<string, string>>({});

const showAddEditConnectionForm = ref(false);
const connectionToEdit = ref<ConnectionInfo | null>(null);
const defaultFolderForNew = ref<number | null>(null);

// Batch Edit Mode
const isBatchEditMode = ref(false);
const selectedConnectionIdsForBatch = ref<Set<number>>(new Set());
const showBatchEditForm = ref(false);
const isDeletingSelectedConnections = ref(false);

// 解析连接项的最终有效背景颜色 (Item 自身 > 所属文件夹 > null)
const getEffectiveConnectionColor = (conn: ConnectionInfo): string | null => {
  let folderColor: string | null = null;
  if (conn.folder_ids && conn.folder_ids.length > 0) {
    const folder = foldersStore.folders.find(f => f.id === conn.folder_ids![0]);
    folderColor = folder?.background_color || null;
  } else if (conn.folders && conn.folders.length > 0) {
    const folder = foldersStore.folders.find(f => conn.folders?.includes(f.name));
    folderColor = folder?.background_color || null;
  }
  return resolveEffectiveColor(conn.background_color, folderColor);
};

const getConnectionCardStyle = (conn: ConnectionInfo) => {
  const effectiveColor = getEffectiveConnectionColor(conn);
  if (!effectiveColor) return {};
  return {
    '--conn-card-bg': hexToRgba(effectiveColor, 0.14),
    '--conn-card-hover-bg': hexToRgba(effectiveColor, 0.22),
    '--conn-card-border': hexToRgba(effectiveColor, 0.32),
    backgroundColor: 'var(--conn-card-bg)',
    borderColor: 'var(--conn-card-border)',
  };
};

const sortOptions: { value: SortField; labelKey: string }[] = [
  { value: 'last_connected_at', labelKey: 'dashboard.sortOptions.lastConnected' },
  { value: 'name', labelKey: 'dashboard.sortOptions.name' },
  { value: 'type', labelKey: 'dashboard.sortOptions.type' },
  { value: 'updated_at', labelKey: 'dashboard.sortOptions.updated' },
  { value: 'created_at', labelKey: 'dashboard.sortOptions.created' },
];

// 统计数量计算
const totalConnectionsCount = computed(() => connections.value.length);
const uncategorizedCount = computed(() => {
  return connections.value.filter(c => !c.folder_ids || c.folder_ids.length === 0).length;
});
const folderCountMap = computed(() => {
  const map = new Map<number, number>();
  folders.value.forEach(f => map.set(f.id, 0));
  connections.value.forEach(c => {
    if (c.folder_ids && c.folder_ids.length > 0) {
      c.folder_ids.forEach(id => {
        map.set(id, (map.get(id) || 0) + 1);
      });
    }
  });
  return map;
});

// 当前展示的文件夹名
const currentFolderTitle = computed(() => {
  if (activeFolder.value === 'all') return t('folders.all', '全部主机');
  if (activeFolder.value === 'uncategorized') return t('folders.uncategorized', '未分类');
  const found = folders.value.find(f => f.id === activeFolder.value);
  return found ? found.name : t('folders.title', '文件夹');
});

// 当前展示的文件夹颜色
const currentFolderColor = computed(() => {
  if (typeof activeFolder.value !== 'number') return null;
  const found = folders.value.find(f => f.id === activeFolder.value);
  return found?.background_color || null;
});

// 过滤与排序
const filteredAndSortedConnections = computed(() => {
  const sortBy = localSortBy.value;
  const sortOrderVal = localSortOrder.value;
  const factor = sortOrderVal === 'desc' ? -1 : 1;
  const targetFolder = activeFolder.value;
  const query = searchQuery.value.toLowerCase().trim();

  let folderFiltered: ConnectionInfo[] = [];
  if (targetFolder === 'all') {
    folderFiltered = [...connections.value];
  } else if (targetFolder === 'uncategorized') {
    folderFiltered = connections.value.filter(conn => !conn.folder_ids || conn.folder_ids.length === 0);
  } else {
    folderFiltered = connections.value.filter(conn => conn.folder_ids?.includes(targetFolder));
  }

  let searchedConnections = folderFiltered;
  if (query) {
    searchedConnections = folderFiltered.filter(conn => {
      const nameMatch = conn.name?.toLowerCase().includes(query);
      const usernameMatch = conn.username?.toLowerCase().includes(query);
      const hostMatch = conn.host?.toLowerCase().includes(query);
      const portMatch = conn.port?.toString().includes(query);
      const notesMatch = conn.notes?.toLowerCase().includes(query);
      return nameMatch || usernameMatch || hostMatch || portMatch || notesMatch;
    });
  }

  return searchedConnections.sort((a, b) => {
    let valA: any;
    let valB: any;

    switch (sortBy) {
      case 'name':
        valA = a.name || '';
        valB = b.name || '';
        return valA.localeCompare(valB) * factor;
      case 'type':
        valA = a.type || '';
        valB = b.type || '';
        return valA.localeCompare(valB) * factor;
      case 'created_at':
        valA = a.created_at ?? 0;
        valB = b.created_at ?? 0;
        return (valA - valB) * factor;
      case 'updated_at':
        valA = a.updated_at ?? 0;
        valB = b.updated_at ?? 0;
        return (valA - valB) * factor;
      case 'last_connected_at':
        valA = a.last_connected_at ?? (sortOrderVal === 'desc' ? -Infinity : Infinity);
        valB = b.last_connected_at ?? (sortOrderVal === 'desc' ? -Infinity : Infinity);
        if (valA === valB) return 0;
        if (valA < valB) return -1 * factor;
        return 1 * factor;
      default:
        return 0;
    }
  });
});

let moveMenuListenersAttached = false;

const attachMoveMenuListeners = () => {
  if (moveMenuListenersAttached) return;
  moveMenuListenersAttached = true;
  document.addEventListener('click', handleGlobalClick, true);
  document.addEventListener('keydown', handleMoveMenuKeydown, true);
  window.addEventListener('resize', updateMoveMenuPosition);
  window.addEventListener('scroll', handleMoveMenuScroll, true);
};

const detachMoveMenuListeners = () => {
  if (!moveMenuListenersAttached) return;
  moveMenuListenersAttached = false;
  document.removeEventListener('click', handleGlobalClick, true);
  document.removeEventListener('keydown', handleMoveMenuKeydown, true);
  window.removeEventListener('resize', updateMoveMenuPosition);
  window.removeEventListener('scroll', handleMoveMenuScroll, true);
};

const closeMoveMenu = () => {
  activeMoveMenu.value = null;
  moveMenuAnchor.value = null;
  detachMoveMenuListeners();
};

const updateMoveMenuPosition = () => {
  if (activeMoveMenu.value === null) return;
  const anchor = moveMenuAnchor.value;
  if (!anchor?.isConnected) {
    closeMoveMenu();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight ||
      rect.right <= 0 || rect.left >= window.innerWidth) {
    closeMoveMenu();
    return;
  }

  const menu = moveMenuRef.value;
  const contentHeight = menu ? menu.scrollHeight + menu.offsetHeight - menu.clientHeight : 320;
  moveMenuStyle.value = getFolderMoveMenuPosition(
    rect, window.innerWidth, window.innerHeight, contentHeight, activeMoveMenu.value !== 'batch',
  );
};

const toggleMoveMenu = async (event: MouseEvent, target: number | 'batch') => {
  if (activeMoveMenu.value === target) {
    closeMoveMenu();
    return;
  }
  moveMenuAnchor.value = event.currentTarget as HTMLElement;
  activeMoveMenu.value = target;
  attachMoveMenuListeners();
  updateMoveMenuPosition();
  await nextTick();
  updateMoveMenuPosition();
};

const handleGlobalClick = (event: MouseEvent) => {
  if (activeMoveMenu.value === null || !(event.target instanceof Node)) return;
  if (moveMenuAnchor.value?.contains(event.target) || moveMenuRef.value?.contains(event.target)) return;
  closeMoveMenu();
};

const handleMoveMenuScroll = (event: Event) => {
  if (activeMoveMenu.value === null) return;
  // 菜单内可正常滚动；外层滚动时关闭，避免触发器被滚动容器裁切后浮层悬空。
  if (event.target instanceof Node && moveMenuRef.value?.contains(event.target)) return;
  closeMoveMenu();
};

const handleMoveMenuKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || activeMoveMenu.value === null) return;
  const anchor = moveMenuAnchor.value;
  closeMoveMenu();
  event.preventDefault();
  event.stopPropagation();
  anchor?.focus({ preventScroll: true });
};

watch(filteredAndSortedConnections, closeMoveMenu);
watch(isBatchEditMode, closeMoveMenu);
watch([showAddEditConnectionForm, showBatchEditForm], ([addOpen, batchOpen]) => {
  if (addOpen || batchOpen) closeMoveMenu();
});
watch(() => selectedConnectionIdsForBatch.value.size, (count) => {
  if (count === 0 && activeMoveMenu.value === 'batch') closeMoveMenu();
});
watch(() => folders.value.length, updateMoveMenuPosition, { flush: 'post' });

onMounted(async () => {
  if (connections.value.length === 0) {
    try {
      await connectionsStore.fetchConnections();
    } catch (error) {
      console.error('加载连接列表失败:', error);
    }
  }
  try {
    await foldersStore.fetchFolders();
  } catch (error) {
    console.error('加载文件夹列表失败:', error);
  }
});

// ConnectionsView 被 KeepAlive 缓存，离开页面或卸载时关闭浮层并释放全局监听。
onDeactivated(closeMoveMenu);
onBeforeUnmount(closeMoveMenu);

const connectTo = (connection: ConnectionInfo) => {
  sessionStore.handleConnectRequest(connection);
};

const toggleSortOrder = () => {
  localSortOrder.value = localSortOrder.value === 'asc' ? 'desc' : 'asc';
};

const isAscending = computed(() => localSortOrder.value === 'asc');

watch(localSortBy, (newValue) => {
  localStorage.setItem(LS_SORT_BY_KEY, newValue);
});

watch(localSortOrder, (newValue) => {
  localStorage.setItem(LS_SORT_ORDER_KEY, newValue);
});

watch(activeFolder, (newValue) => {
  localStorage.setItem(LS_ACTIVE_FOLDER_KEY, String(newValue));
  // 切换文件夹时清空批量选中
  selectedConnectionIdsForBatch.value.clear();
});

const dateFnsLocales: Record<string, Locale> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': ja,
  'en': enUS,
  'zh': zhCN,
  'ja': ja,
};

const formatRelativeTime = (timestampInSeconds: number | null | undefined): string => {
  if (!timestampInSeconds) return t('connections.status.never');
  try {
    const timestampInMs = timestampInSeconds * 1000;
    if (isNaN(timestampInMs)) return String(timestampInSeconds);
    const date = new Date(timestampInMs);
    const currentI18nLocale = locale.value;
    const langPart = currentI18nLocale.split('-')[0];
    let targetDateFnsLocale = dateFnsLocales[currentI18nLocale] || dateFnsLocales[langPart] || enUS;
    return formatDistanceToNow(date, { addSuffix: true, locale: targetDateFnsLocale });
  } catch (e) {
    return String(timestampInSeconds);
  }
};

const getFolderName = (folderId: number): string => {
  const f = folders.value.find(item => item.id === folderId);
  return f ? f.name : '';
};

// --- 文件夹管理交互 ---
const startCreateFolder = () => {
  isCreatingFolder.value = true;
  newFolderName.value = '';
  nextTick(() => {
    newFolderInputRef.value?.focus();
  });
};

const cancelCreateFolder = () => {
  isCreatingFolder.value = false;
  newFolderName.value = '';
};

const handleConfirmCreateFolder = async () => {
  const trimmed = newFolderName.value.trim();
  if (!trimmed) {
    cancelCreateFolder();
    return;
  }
  const created = await foldersStore.createFolder(trimmed);
  if (created) {
    uiNotificationsStore.showSuccess(t('folders.newFolderSuccess', '文件夹已创建'));
    activeFolder.value = created.id;
  }
  isCreatingFolder.value = false;
  newFolderName.value = '';
};

const startRenameFolder = (folder: FolderInfo, e: Event) => {
  e.stopPropagation();
  editingFolderId.value = folder.id;
  editingFolderName.value = folder.name;
  nextTick(() => {
    editFolderInputRef.value?.focus();
  });
};

const cancelRenameFolder = () => {
  editingFolderId.value = null;
  editingFolderName.value = '';
};

const handleConfirmRenameFolder = async (folderId: number) => {
  const trimmed = editingFolderName.value.trim();
  if (!trimmed || trimmed === getFolderName(folderId)) {
    cancelRenameFolder();
    return;
  }
  const ok = await foldersStore.renameFolder(folderId, trimmed);
  if (ok) {
    uiNotificationsStore.showSuccess(t('folders.renameSuccess', '文件夹名称已修改'));
  }
  cancelRenameFolder();
};

const handleDeleteFolder = async (folder: FolderInfo, e: Event) => {
  e.stopPropagation();
  const confirmed = await showConfirmDialog({
    title: t('folders.deleteConfirmTitle', '删除文件夹'),
    message: t('folders.deleteConfirm', { name: folder.name }, `确定要删除文件夹 "${folder.name}" 吗？内部条目将保留并移至“未分类”。`),
  });
  if (confirmed) {
    const ok = await foldersStore.deleteFolder(folder.id);
    if (ok) {
      uiNotificationsStore.showSuccess(t('folders.deleteSuccess', '文件夹已删除'));
      if (activeFolder.value === folder.id) {
        activeFolder.value = 'all';
      }
      await connectionsStore.fetchConnections();
    }
  }
};

// --- 拖拽与快捷归类 ---
const handleDragStart = (conn: ConnectionInfo, e: DragEvent) => {
  draggedConnectionId.value = conn.id;
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', String(conn.id));
    e.dataTransfer.effectAllowed = 'move';
  }
};

const handleDragEnd = () => {
  draggedConnectionId.value = null;
  dragOverFolderId.value = null;
};

const handleDragOver = (folderTarget: ActiveFolderType, e: DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
  dragOverFolderId.value = folderTarget;
};

const handleDragLeave = () => {
  dragOverFolderId.value = null;
};

const handleDropOnFolder = async (target: ActiveFolderType, e: DragEvent) => {
  e.preventDefault();
  dragOverFolderId.value = null;
  const connId = draggedConnectionId.value || parseInt(e.dataTransfer?.getData('text/plain') || '', 10);
  if (!connId || isNaN(connId)) return;

  const targetFolderId = typeof target === 'number' ? target : null;
  const success = await connectionsStore.moveConnectionToFolder(connId, targetFolderId);
  if (success) {
    const targetName = target === 'uncategorized'
      ? t('folders.uncategorized', '未分类')
      : (typeof target === 'number' ? getFolderName(target) : t('folders.all', '全部'));
    uiNotificationsStore.showSuccess(t('folders.movedSuccessTo', { name: targetName }, `已移动至 ${targetName}`));
  }
};

const handleMoveSingleConnection = async (connId: number, targetFolderId: number | null) => {
  closeMoveMenu();
  const ok = await connectionsStore.moveConnectionToFolder(connId, targetFolderId);
  if (ok) {
    const targetName = targetFolderId ? getFolderName(targetFolderId) : t('folders.uncategorized', '未分类');
    uiNotificationsStore.showSuccess(t('folders.movedSuccessTo', { name: targetName }, `已移动至 ${targetName}`));
  }
};

const handleBatchMoveToFolder = async (targetFolderId: number | null) => {
  closeMoveMenu();
  if (selectedConnectionIdsForBatch.value.size === 0) return;
  const ids = Array.from(selectedConnectionIdsForBatch.value);
  const ok = await connectionsStore.batchMoveConnectionsToFolder(ids, targetFolderId);
  if (ok) {
    const targetName = targetFolderId ? getFolderName(targetFolderId) : t('folders.uncategorized', '未分类');
    uiNotificationsStore.showSuccess(t('folders.batchMoveSuccess', { count: ids.length, name: targetName }, `已将 ${ids.length} 个连接移动至 ${targetName}`));
    selectedConnectionIdsForBatch.value.clear();
  }
};

const selectMoveFolder = (folderId: number | null) => {
  const target = activeMoveMenu.value;
  if (target === 'batch') return handleBatchMoveToFolder(folderId);
  if (target !== null) return handleMoveSingleConnection(target, folderId);
};

// --- 表单与批处理 ---
const openAddConnectionForm = () => {
  connectionToEdit.value = null;
  // 若当前聚焦在某个具体文件夹下，默认将新连接归属于该文件夹
  defaultFolderForNew.value = typeof activeFolder.value === 'number' ? activeFolder.value : null;
  showAddEditConnectionForm.value = true;
};

const openEditConnectionForm = (conn: ConnectionInfo) => {
  connectionToEdit.value = conn;
  defaultFolderForNew.value = null;
  showAddEditConnectionForm.value = true;
};

const handleFormClose = () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null;
  defaultFolderForNew.value = null;
};

const handleConnectionModified = async () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null;
  defaultFolderForNew.value = null;
  await connectionsStore.fetchConnections();
};

const toggleBatchEditMode = () => {
  isBatchEditMode.value = !isBatchEditMode.value;
  if (!isBatchEditMode.value) {
    selectedConnectionIdsForBatch.value.clear();
  }
};

const handleConnectionClick = (connId: number) => {
  if (!isBatchEditMode.value) return;
  if (selectedConnectionIdsForBatch.value.has(connId)) {
    selectedConnectionIdsForBatch.value.delete(connId);
  } else {
    selectedConnectionIdsForBatch.value.add(connId);
  }
};

const isConnectionSelectedForBatch = (connId: number): boolean => {
  return selectedConnectionIdsForBatch.value.has(connId);
};

const selectAllConnections = () => {
  if (!isBatchEditMode.value) return;
  filteredAndSortedConnections.value.forEach(conn => selectedConnectionIdsForBatch.value.add(conn.id));
};

const deselectAllConnections = () => {
  if (!isBatchEditMode.value) return;
  selectedConnectionIdsForBatch.value.clear();
};

const invertSelection = () => {
  if (!isBatchEditMode.value) return;
  const allVisibleIds = new Set(filteredAndSortedConnections.value.map(conn => conn.id));
  allVisibleIds.forEach(id => {
    if (selectedConnectionIdsForBatch.value.has(id)) {
      selectedConnectionIdsForBatch.value.delete(id);
    } else {
      selectedConnectionIdsForBatch.value.add(id);
    }
  });
};

const openBatchEditModal = () => {
  if (selectedConnectionIdsForBatch.value.size === 0) {
    showAlertDialog({ title: t('common.alert', '提示'), message: t('connections.batchEdit.noSelectionForEdit', '请至少选择一个主机进行编辑。') });
    return;
  }
  showBatchEditForm.value = true;
};

const handleBatchEditSaved = async () => {
  showBatchEditForm.value = false;
  selectedConnectionIdsForBatch.value.clear();
  await connectionsStore.fetchConnections();
};

const handleBatchEditFormClose = () => {
  showBatchEditForm.value = false;
};

const handleBatchDeleteConnections = async () => {
  if (selectedConnectionIdsForBatch.value.size === 0 || isDeletingSelectedConnections.value) return;

  const confirmMessage = t(
    'connections.batchEdit.confirmMessage',
    { count: selectedConnectionIdsForBatch.value.size },
    `您确定要删除选中的 ${selectedConnectionIdsForBatch.value.size} 个连接吗？此操作无法撤销。`
  );

  const confirmed = await showConfirmDialog({ message: confirmMessage });
  if (confirmed) {
    isDeletingSelectedConnections.value = true;
    try {
      const idsToDelete = Array.from(selectedConnectionIdsForBatch.value);
      await connectionsStore.deleteBatchConnections(idsToDelete);
      showAlertDialog({ title: t('common.success', '成功'), message: t('connections.batchEdit.successMessage', '选中的主机已成功删除。') });
      selectedConnectionIdsForBatch.value.clear();
      await connectionsStore.fetchConnections();
    } catch (error: any) {
      showAlertDialog({ title: t('common.error'), message: t('connections.batchEdit.errorMessage', `批量删除连接失败: ${error.message || '未知错误'}`) });
    } finally {
      isDeletingSelectedConnections.value = false;
    }
  }
};

// --- 测试连接 ---
interface ConnectionTestState {
  status: 'idle' | 'testing' | 'success' | 'error';
  resultText: string;
  latency?: number;
  latencyColor?: string;
}
const connectionTestStates = ref<Map<number, ConnectionTestState>>(new Map());
const isTestingAll = ref(false);

const getLatencyColorString = (latencyMs?: number): string => {
  if (latencyMs === undefined) return 'inherit';
  if (latencyMs < 100) return 'var(--color-success, #4CAF50)';
  if (latencyMs < 300) return 'var(--color-warning, #ff9800)';
  return 'var(--color-error, #F44336)';
};

const handleTestSingleConnection = async (conn: ConnectionInfo) => {
  if (!conn.id || conn.type !== 'SSH') return;
  connectionTestStates.value.set(conn.id, {
    status: 'testing',
    resultText: t('connections.test.testingInProgress', '测试中...'),
  });

  try {
    const result = await connectionsStore.testConnection(conn.id);
    if (result.success) {
      const latencyMs = result.latency;
      let displayText = latencyMs !== undefined ? `${latencyMs}ms` : '';
      let determinedColor = getLatencyColorString(latencyMs ?? 0);
      connectionTestStates.value.set(conn.id, {
        status: 'success',
        resultText: displayText,
        latency: latencyMs,
        latencyColor: determinedColor,
      });
    } else {
      connectionTestStates.value.set(conn.id, {
        status: 'error',
        resultText: result.message || t('connections.test.unknownError', '未知错误'),
      });
    }
  } catch (error: any) {
    connectionTestStates.value.set(conn.id, {
      status: 'error',
      resultText: error.message || t('connections.test.unknownError', '未知错误'),
    });
  }
};

const handleTestAllFilteredConnections = async () => {
  if (isTestingAll.value || isLoadingConnections.value) return;
  const sshConnectionsToTest = filteredAndSortedConnections.value.filter(c => c.type === 'SSH' && c.id != null);
  if (sshConnectionsToTest.length === 0) return;

  isTestingAll.value = true;
  const testPromises = sshConnectionsToTest.map(conn => {
    return handleTestSingleConnection(conn).catch(() => {
      connectionTestStates.value.set(conn.id!, {
        status: 'error',
        resultText: t('connections.test.unknownErrorDuringBatch', '批量测试中发生错误'),
      });
    });
  });

  try {
    await Promise.all(testPromises);
  } finally {
    isTestingAll.value = false;
  }
};

const getSingleTestButtonInfo = (connId: number | undefined, connType: string | undefined) => {
  const state = connId ? connectionTestStates.value.get(connId) : undefined;
  if (connType !== 'SSH') {
    return { textKey: 'connections.actions.test', iconClass: 'fas fa-plug', disabled: true, loading: false, title: t('connections.test.onlySshSupportedTest', '仅 SSH 主机支持测试。') };
  }
  if (!connId) {
    return { textKey: 'connections.actions.test', iconClass: 'fas fa-plug', disabled: true, loading: false, title: '' };
  }
  if (state?.status === 'testing') {
    return { textKey: 'connections.actions.testing', iconClass: 'fas fa-spinner fa-spin', disabled: true, loading: true, title: t('connections.actions.testing', '测试中') };
  }
  return { textKey: 'connections.actions.test', iconClass: 'fas fa-plug', disabled: false, loading: false, title: t('connections.actions.test', '测试') };
};

const getTruncatedNotes = (notes: string | null | undefined): string => {
  if (!notes || notes.trim() === '') return '';
  const maxLength = 80;
  if (notes.length <= maxLength) return notes;
  return notes.substring(0, maxLength) + '...';
};

// 一键连接全部
const isConnectingAll = ref(false);
const handleConnectAllFilteredConnections = async () => {
  if (isConnectingAll.value || isLoadingConnections.value) return;
  const sshConnectionsToConnect = filteredAndSortedConnections.value.filter(conn => conn.type === 'SSH');
  if (sshConnectionsToConnect.length === 0) return;

  isConnectingAll.value = true;
  try {
    for (const conn of sshConnectionsToConnect) {
      connectTo(conn);
    }
  } finally {
    isConnectingAll.value = false;
  }
};
</script>

<template>
  <div class="h-full flex flex-col p-3 md:p-6 bg-background text-foreground overflow-hidden">
    <!-- Top Navigation Bar & Stats -->
    <div class="flex items-center justify-between mb-4 flex-shrink-0">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-xs">
          <i class="fas fa-network-wired text-base"></i>
        </div>
        <div>
          <h1 class="text-xl md:text-2xl font-bold tracking-tight text-foreground">{{ t('nav.connections', '主机管理') }}</h1>
          <p class="text-xs text-text-secondary">
            {{ t('folders.dragTip', '按文件夹层级分类管理主机，支持拖拽快速归类') }}
          </p>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-2">
        <button
          @click="openAddConnectionForm"
          class="h-9 px-3.5 bg-primary text-white rounded-lg shadow-sm hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/50 transition duration-150 flex items-center gap-1.5 text-xs md:text-sm font-semibold"
        >
          <i class="fas fa-plus"></i>
          <span>{{ t('connections.addConnection', '新建主机') }}</span>
        </button>
      </div>
    </div>

    <!-- Main Dual-Pane Workspace Container -->
    <div class="flex-1 flex flex-col md:flex-row overflow-hidden border border-border/70 rounded-2xl bg-background shadow-sm">
      <!-- ==================== Left: Folder Sidebar ==================== -->
      <aside class="w-full md:w-64 lg:w-72 flex-shrink-0 border-b md:border-b-0 md:border-r border-border/60 bg-background/60 flex flex-col overflow-hidden">
        <!-- Sidebar Header: Quick Navigation -->
        <div class="p-3 border-b border-border/50 space-y-1">
          <!-- All Connections -->
          <button
            @click="activeFolder = 'all'"
            @dragover="handleDragOver('all', $event)"
            @dragleave="handleDragLeave"
            @drop="handleDropOnFolder('all', $event)"
            class="w-full flex items-center justify-between px-3 h-9 rounded-xl text-xs md:text-sm transition-all duration-150 border border-transparent"
            :class="[
              activeFolder === 'all'
                ? 'bg-primary/15 text-primary font-semibold shadow-xs border-primary/30 ring-1 ring-primary/30'
                : 'text-text-secondary hover:text-foreground hover:bg-muted/60',
              { 'ring-2 ring-primary bg-primary/20': dragOverFolderId === 'all' }
            ]"
          >
            <div class="flex items-center gap-2.5 truncate">
              <i class="fas fa-layer-group w-4 text-center text-primary"></i>
              <span class="truncate">{{ t('folders.all', '全部主机') }}</span>
            </div>
            <span
              class="px-2 h-5 min-w-[20px] flex items-center justify-center text-xs rounded-full font-medium"
              :class="activeFolder === 'all' ? 'bg-primary/20 text-primary' : 'bg-muted text-text-secondary'"
            >
              {{ totalConnectionsCount }}
            </span>
          </button>

          <!-- Uncategorized -->
          <button
            @click="activeFolder = 'uncategorized'"
            @dragover="handleDragOver('uncategorized', $event)"
            @dragleave="handleDragLeave"
            @drop="handleDropOnFolder('uncategorized', $event)"
            class="w-full flex items-center justify-between px-3 h-9 rounded-xl text-xs md:text-sm transition-all duration-150 border border-transparent"
            :class="[
              activeFolder === 'uncategorized'
                ? 'bg-primary/15 text-primary font-semibold shadow-xs border-primary/30 ring-1 ring-primary/30'
                : 'text-text-secondary hover:text-foreground hover:bg-muted/60',
              { 'ring-2 ring-primary bg-primary/20': dragOverFolderId === 'uncategorized' }
            ]"
          >
            <div class="flex items-center gap-2.5 truncate">
              <i class="fas fa-inbox w-4 text-center text-text-secondary"></i>
              <span class="truncate">{{ t('folders.uncategorized', '未分类') }}</span>
            </div>
            <span
              class="px-2 h-5 min-w-[20px] flex items-center justify-center text-xs rounded-full font-medium"
              :class="activeFolder === 'uncategorized' ? 'bg-primary/20 text-primary' : 'bg-muted text-text-secondary'"
            >
              {{ uncategorizedCount }}
            </span>
          </button>
        </div>

        <!-- Custom Folders Section Title & Add Button -->
        <div class="px-3 py-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-text-secondary/80">
          <span>{{ t('folders.customFolders', '文件夹') }}</span>
          <button
            @click="startCreateFolder"
            class="w-6 h-6 flex items-center justify-center rounded-md hover:bg-muted text-text-secondary hover:text-foreground transition-colors"
            :title="t('folders.newFolder', '新建文件夹')"
          >
            <i class="fas fa-plus text-xs"></i>
          </button>
        </div>

        <!-- Folder Inline Creation Input -->
        <div v-if="isCreatingFolder" class="px-3 pb-2">
          <div class="flex items-center gap-1.5 p-1.5 bg-input border border-primary/50 rounded-lg shadow-inner">
            <i class="fas fa-folder text-amber-400 text-xs pl-1"></i>
            <input
              ref="newFolderInputRef"
              v-model="newFolderName"
              type="text"
              :placeholder="t('folders.newFolderPlaceholder', '输入文件夹名称...')"
              class="flex-1 min-w-0 bg-transparent text-foreground text-xs focus:outline-none"
              @keydown.enter.prevent="handleConfirmCreateFolder"
              @keydown.esc.prevent="cancelCreateFolder"
            />
            <button
              @click="handleConfirmCreateFolder"
              class="px-2 py-0.5 bg-primary text-white text-xs rounded hover:bg-primary/90"
            >
              <i class="fas fa-check text-xs"></i>
            </button>
            <button
              @click="cancelCreateFolder"
              class="px-1.5 py-0.5 text-text-secondary hover:text-foreground text-xs"
            >
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
        </div>

        <!-- Folder List Area -->
        <div class="flex-1 overflow-y-auto px-2 space-y-0.5 pb-3">
          <div
            v-for="folder in folders"
            :key="folder.id"
            @click="activeFolder = folder.id"
            @dragover="handleDragOver(folder.id, $event)"
            @dragleave="handleDragLeave"
            @drop="handleDropOnFolder(folder.id, $event)"
            class="group w-full flex items-center justify-between px-3 h-9 min-h-[36px] max-h-[36px] box-border rounded-xl text-xs md:text-sm transition-all duration-150 cursor-pointer border border-transparent"
            :class="[
              activeFolder === folder.id
                ? 'bg-primary/15 text-primary font-semibold shadow-xs border-primary/30 ring-1 ring-primary/30'
                : 'text-foreground hover:bg-muted/60',
              { 'ring-2 ring-primary bg-primary/20': dragOverFolderId === folder.id }
            ]"
          >
            <!-- Editing State -->
            <div v-if="editingFolderId === folder.id" class="flex-1 flex items-center gap-1.5 mr-1 h-full" @click.stop>
              <i class="fas fa-folder text-amber-400 text-xs"></i>
              <input
                ref="editFolderInputRef"
                v-model="editingFolderName"
                type="text"
                class="flex-1 min-w-0 px-1.5 py-0.5 bg-input border border-primary rounded text-xs text-foreground focus:outline-none"
                @keydown.enter.prevent="handleConfirmRenameFolder(folder.id)"
                @keydown.esc.prevent="cancelRenameFolder"
              />
              <button
                @click="handleConfirmRenameFolder(folder.id)"
                class="w-6 h-6 p-0 flex items-center justify-center text-primary hover:text-primary-hover rounded"
              >
                <i class="fas fa-check text-xs"></i>
              </button>
              <button
                @click="cancelRenameFolder"
                class="w-6 h-6 p-0 flex items-center justify-center text-text-secondary hover:text-foreground rounded"
              >
                <i class="fas fa-times text-xs"></i>
              </button>
            </div>

            <!-- Normal Display State -->
            <template v-else>
              <div class="flex items-center gap-2 truncate min-w-0 mr-2 flex-1">
                <i
                  :class="[
                    'fas w-4 text-center flex-shrink-0 transition-colors',
                    activeFolder === folder.id ? 'fa-folder-open' : 'fa-folder',
                    folder.background_color ? '' : 'text-amber-400'
                  ]"
                  :style="folder.background_color ? { color: folder.background_color } : {}"
                ></i>
                <span class="truncate">{{ folder.name }}</span>
              </div>

              <div class="flex items-center gap-1 flex-shrink-0 h-6">
                <!-- Action Buttons on Hover -->
                <div class="hidden group-hover:flex items-center gap-0.5 mr-0.5" @click.stop>
                  <!-- 文件夹背景颜色选择按钮与浮层 -->
                  <div class="relative inline-flex items-center" @click.stop>
                    <button
                      @click="toggleFolderColorPicker(folder.id, $event)"
                      class="w-6 h-6 p-0 flex items-center justify-center rounded hover:bg-muted transition-colors cursor-pointer"
                      :class="folder.background_color ? 'text-primary' : 'text-text-secondary hover:text-foreground'"
                      :title="t('folders.setBackgroundColor', '设置文件夹背景色')"
                    >
                      <i class="fas fa-palette text-xs"></i>
                    </button>
                    <ColorPickerPopover
                      :visible="activeColorPickerFolderId === folder.id"
                      :trigger-el="activeColorPickerTriggerEl"
                      :model-value="folder.background_color"
                      :title="t('folders.folderBackgroundColor', '文件夹背景色')"
                      @update:model-value="handleSaveFolderColor(folder.id, $event)"
                      @close="activeColorPickerFolderId = null; activeColorPickerTriggerEl = null"
                    />
                  </div>

                  <button
                    @click="startRenameFolder(folder, $event)"
                    class="w-6 h-6 p-0 flex items-center justify-center text-text-secondary hover:text-foreground rounded hover:bg-muted cursor-pointer"
                    :title="t('folders.renameFolder', '重命名')"
                  >
                    <i class="fas fa-pencil-alt text-xs"></i>
                  </button>
                  <button
                    @click="handleDeleteFolder(folder, $event)"
                    class="w-6 h-6 p-0 flex items-center justify-center text-text-secondary hover:text-error rounded hover:bg-muted cursor-pointer"
                    :title="t('folders.deleteFolder', '删除')"
                  >
                    <i class="fas fa-trash-alt text-xs"></i>
                  </button>
                </div>

                <span
                  class="px-2 h-5 min-w-[20px] flex items-center justify-center text-xs rounded-full font-medium"
                  :class="activeFolder === folder.id ? 'bg-primary/20 text-primary' : 'bg-muted text-text-secondary'"
                >
                  {{ folderCountMap.get(folder.id) || 0 }}
                </span>
              </div>
            </template>
          </div>

          <div v-if="folders.length === 0 && !isCreatingFolder" class="p-6 text-center text-xs text-text-secondary italic">
            <i class="fas fa-folder-open text-xl mb-1.5 opacity-40 block"></i>
            {{ t('folders.noCustomFolders', '暂无自定义文件夹') }}
          </div>
        </div>
      </aside>

      <!-- ==================== Right: Connection Content Area ==================== -->
      <main class="flex-1 flex flex-col overflow-hidden bg-background">
        <!-- Top Toolbar -->
        <div class="p-3 md:p-4 border-b border-border/60 flex flex-wrap items-center justify-between gap-3 bg-background/90 backdrop-blur-xs flex-shrink-0">
          <!-- Folder Title and Item Count -->
          <div class="flex items-center gap-2 min-w-0">
            <div class="flex items-center gap-2">
              <i
                :class="[
                  'fas transition-colors',
                  activeFolder === 'all'
                    ? 'fa-layer-group text-primary'
                    : (activeFolder === 'uncategorized' ? 'fa-inbox text-text-secondary' : 'fa-folder-open'),
                  (activeFolder !== 'all' && activeFolder !== 'uncategorized' && !currentFolderColor) ? 'text-amber-400' : ''
                ]"
                :style="currentFolderColor ? { color: currentFolderColor } : {}"
              ></i>
              <h2 class="text-base md:text-lg font-semibold text-foreground truncate">
                {{ currentFolderTitle }}
              </h2>
            </div>
            <span class="text-xs text-text-secondary bg-muted px-2 py-0.5 rounded-full font-medium">
              {{ filteredAndSortedConnections.length }}
            </span>
          </div>

          <!-- Controls: Search, Sort, Batch Mode, Batch Connect/Test -->
          <div class="flex flex-wrap items-center gap-2 ml-auto">
            <!-- Search Bar -->
            <div class="relative w-40 sm:w-52">
              <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary text-xs"></i>
              <input
                type="text"
                v-model="searchQuery"
                :placeholder="t('dashboard.searchConnectionsPlaceholder', '搜索主机...')"
                class="w-full h-8 pl-8 pr-3 text-xs bg-input border border-border/70 rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition duration-150"
              />
            </div>

            <!-- Sort By -->
            <AppSelect
              v-model="localSortBy"
              class="h-8 px-2.5 text-xs bg-input border border-border/70 rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 cursor-pointer"
            >
              <option v-for="option in sortOptions" :key="option.value" :value="option.value">
                {{ t(option.labelKey, option.value) }}
              </option>
            </AppSelect>

            <!-- Sort Order Toggle -->
            <button
              @click="toggleSortOrder"
              class="h-8 w-8 flex items-center justify-center border border-border/70 rounded-lg text-text-secondary hover:text-foreground hover:bg-muted transition duration-150"
              :title="isAscending ? t('common.sortAscending') : t('common.sortDescending')"
            >
              <i :class="['fas', isAscending ? 'fa-arrow-up-a-z' : 'fa-arrow-down-z-a', 'text-xs']"></i>
            </button>

            <!-- Batch Mode Switch -->
            <button
              @click="toggleBatchEditMode"
              class="h-8 px-2.5 flex items-center gap-1.5 border rounded-lg text-xs font-medium transition duration-150"
              :class="isBatchEditMode ? 'bg-primary/20 text-primary border-primary/50' : 'border-border/70 text-text-secondary hover:bg-muted hover:text-foreground'"
              :title="t('connections.batchEdit.toggleLabel', '批量操作')"
            >
              <i class="fas fa-tasks text-xs"></i>
              <span class="hidden sm:inline">{{ t('connections.batchEdit.toggleLabel', '批量') }}</span>
            </button>

            <!-- Test All Filtered SSH -->
            <button
              @click="handleTestAllFilteredConnections"
              :disabled="isTestingAll || isLoadingConnections || !filteredAndSortedConnections.some(c => c.type === 'SSH')"
              class="h-8 px-2.5 bg-muted text-foreground border border-border/70 rounded-lg hover:bg-border transition duration-150 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              :title="t('connections.actions.testAllFiltered', '测试全部筛选的SSH连接')"
            >
              <i v-if="isTestingAll" class="fas fa-spinner fa-spin text-xs"></i>
              <i v-else class="fas fa-check-double text-xs"></i>
              <span class="hidden md:inline">{{ t('connections.actions.testAllFiltered', '测速') }}</span>
            </button>

            <!-- Connect All Filtered SSH -->
            <button
              @click="handleConnectAllFilteredConnections"
              :disabled="isConnectingAll || isLoadingConnections || !filteredAndSortedConnections.some(c => c.type === 'SSH')"
              class="h-8 px-2.5 bg-primary/10 text-primary border border-primary/30 rounded-lg hover:bg-primary/20 transition duration-150 flex items-center gap-1.5 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              :title="t('workspaceConnectionList.connectAllSshInGroupMenu', '连接全部')"
            >
              <i v-if="isConnectingAll" class="fas fa-spinner fa-spin text-xs"></i>
              <i v-else class="fas fa-network-wired text-xs"></i>
              <span class="hidden md:inline">{{ t('workspaceConnectionList.connectAllSshInGroupMenu', '全部主机') }}</span>
            </button>
          </div>
        </div>

        <!-- Batch Action Bar -->
        <div v-if="isBatchEditMode" class="px-4 py-2 bg-primary/10 border-b border-primary/20 flex flex-wrap items-center justify-between gap-2 animate-fadeIn flex-shrink-0">
          <div class="flex items-center gap-2 text-xs">
            <span class="font-semibold text-primary">已选 {{ selectedConnectionIdsForBatch.size }} 项</span>
            <button @click="selectAllConnections" class="text-text-secondary hover:text-foreground underline">全选</button>
            <button @click="deselectAllConnections" class="text-text-secondary hover:text-foreground underline">取消全选</button>
            <button @click="invertSelection" class="text-text-secondary hover:text-foreground underline">反选</button>
          </div>

          <div class="flex items-center gap-2">
            <!-- Batch Move to Folder Dropdown -->
            <div class="relative">
              <button
                type="button"
                @click.stop="toggleMoveMenu($event, 'batch')"
                :aria-expanded="activeMoveMenu === 'batch'"
                :disabled="selectedConnectionIdsForBatch.size === 0"
                class="px-2.5 py-1 text-xs bg-input border border-border rounded-lg text-foreground hover:bg-muted flex items-center gap-1.5 disabled:opacity-50"
              >
                <i class="fas fa-folder-tree text-amber-400"></i>
                <span>{{ t('folders.batchMove', '移动至文件夹') }}</span>
                <i class="fas fa-chevron-down text-xs"></i>
              </button>

            </div>

            <!-- Batch Edit -->
            <button
              @click="openBatchEditModal"
              :disabled="selectedConnectionIdsForBatch.size === 0"
              class="px-2.5 py-1 text-xs bg-input border border-border rounded-lg text-foreground hover:bg-muted flex items-center gap-1.5 disabled:opacity-50"
            >
              <i class="fas fa-edit text-xs"></i>
              <span>编辑</span>
            </button>

            <!-- Batch Delete -->
            <button
              @click="handleBatchDeleteConnections"
              :disabled="selectedConnectionIdsForBatch.size === 0 || isDeletingSelectedConnections"
              class="px-2.5 py-1 text-xs bg-red-600/90 text-white rounded-lg hover:bg-red-700 flex items-center gap-1.5 disabled:opacity-50"
            >
              <i class="fas fa-trash-alt text-xs"></i>
              <span>删除</span>
            </button>
          </div>
        </div>

        <!-- Connection Cards List / Grid -->
        <div class="flex-1 overflow-y-auto p-3 md:p-4">
          <div v-if="isLoadingConnections && filteredAndSortedConnections.length === 0" class="flex flex-col items-center justify-center h-64 text-text-secondary">
            <i class="fas fa-spinner fa-spin text-2xl mb-2 text-primary"></i>
            <span class="text-xs">{{ t('common.loading') }}</span>
          </div>

          <!-- Connection Cards -->
          <div v-else-if="filteredAndSortedConnections.length > 0" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <div
              v-for="conn in filteredAndSortedConnections"
              :key="conn.id"
              :draggable="!isBatchEditMode"
              @dragstart="handleDragStart(conn, $event)"
              @dragend="handleDragEnd"
              @click="handleConnectionClick(conn.id)"
              class="group relative flex flex-col justify-between p-3.5 rounded-xl border transition-all duration-200"
              :class="[
                getEffectiveConnectionColor(conn) ? 'connection-colored-card' : 'bg-card/70 hover:bg-muted/40 border-border/70 shadow-xs hover:shadow-md hover:border-primary/40',
                { 'ring-2 ring-primary ring-offset-1 ring-offset-background': isBatchEditMode && isConnectionSelectedForBatch(conn.id) },
                { 'cursor-pointer': isBatchEditMode, 'cursor-grab active:cursor-grabbing': !isBatchEditMode }
              ]"
              :style="getConnectionCardStyle(conn)"
            >
              <!-- Card Top: Protocol Badge, Name & Folder Badge -->
              <div>
                <div class="flex items-start justify-between gap-2 mb-1.5">
                  <div class="flex items-center gap-2 min-w-0">
                    <!-- Protocol Icon / Type Badge -->
                    <span
                      class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 flex-shrink-0"
                      :class="[
                        conn.type === 'SSH' ? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30' :
                        (conn.type === 'RDP' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30' :
                        'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30')
                      ]"
                    >
                      <i :class="['fas', conn.type === 'VNC' ? 'fa-plug' : (conn.type === 'RDP' ? 'fa-desktop' : 'fa-terminal')]"></i>
                      {{ conn.type }}
                    </span>

                    <!-- Connection Name -->
                    <h3 class="font-semibold text-sm text-foreground truncate" :title="conn.name || conn.host">
                      {{ conn.name || conn.host || t('connections.unnamedFallback', '未命名主机') }}
                    </h3>
                  </div>

                  <!-- Folder Folder Badge (Clickable to switch folder) -->
                  <div class="flex items-center gap-1 flex-shrink-0">
                    <span
                      v-if="conn.folder_ids && conn.folder_ids.length > 0"
                      @click.stop="activeFolder = conn.folder_ids[0]"
                      class="px-2 py-0.5 text-[11px] rounded-md bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 cursor-pointer transition-colors flex items-center gap-1 font-medium"
                      :title="t('folders.viewFolderOnly', '仅查看此文件夹')"
                    >
                      <i class="fas fa-folder text-[10px]"></i>
                      <span class="max-w-[80px] truncate">{{ getFolderName(conn.folder_ids[0]) }}</span>
                    </span>

                    <span
                      v-else
                      class="px-1.5 py-0.5 text-[10px] rounded-md bg-muted text-text-secondary/70 flex items-center gap-1"
                    >
                      <i class="fas fa-inbox text-[9px]"></i>
                      <span>未分类</span>
                    </span>
                  </div>
                </div>

                <!-- Host & Username -->
                <div class="text-xs text-text-secondary font-mono truncate mb-1" :title="`${conn.username}@${conn.host}:${conn.port}`">
                  {{ conn.username }}@{{ conn.host }}:{{ conn.port }}
                </div>

                <!-- Last Connected & Notes -->
                <div class="flex items-center justify-between text-[11px] text-text-secondary/80 mt-1">
                  <span>{{ formatRelativeTime(conn.last_connected_at) }}</span>
                  <span v-if="conn.notes" class="truncate max-w-[140px] italic text-text-secondary/70" :title="conn.notes">
                    {{ getTruncatedNotes(conn.notes) }}
                  </span>
                </div>

                <!-- Test Status Result Bar -->
                <div
                  v-if="conn.type === 'SSH' && connectionTestStates.get(conn.id) && connectionTestStates.get(conn.id)?.status !== 'idle'"
                  class="text-xs mt-2 pt-1.5 border-t border-border/40"
                >
                  <div v-if="connectionTestStates.get(conn.id)?.status === 'testing'" class="text-text-secondary animate-pulse flex items-center gap-1 text-[11px]">
                    <i class="fas fa-spinner fa-spin text-xs"></i>
                    <span>{{ t('connections.test.testingInProgress', '测试中...') }}</span>
                  </div>
                  <div
                    v-else-if="connectionTestStates.get(conn.id)?.status === 'success'"
                    class="font-medium flex items-center gap-1 text-[11px]"
                    :style="{ color: connectionTestStates.get(conn.id)?.latencyColor || 'inherit' }"
                  >
                    <i class="fas fa-check-circle text-xs"></i>
                    <span>{{ connectionTestStates.get(conn.id)?.resultText }}</span>
                  </div>
                  <div
                    v-else-if="connectionTestStates.get(conn.id)?.status === 'error'"
                    class="text-error font-medium flex items-center gap-1 text-[11px]"
                  >
                    <i class="fas fa-times-circle text-xs"></i>
                    <span class="truncate">{{ connectionTestStates.get(conn.id)?.resultText }}</span>
                  </div>
                </div>
              </div>

              <!-- Card Bottom Actions -->
              <div class="mt-3 pt-2.5 border-t border-border/50 flex items-center justify-between gap-1.5">
                <!-- Move to Folder Shortcut Menu Button -->
                <div class="relative">
                  <button
                    type="button"
                    @click.stop="toggleMoveMenu($event, conn.id)"
                    :aria-expanded="activeMoveMenu === conn.id"
                    class="h-7 px-2 text-xs rounded-md text-text-secondary hover:text-foreground hover:bg-muted flex items-center gap-1 border border-border/50"
                    :title="t('folders.moveToFolder', '移至文件夹')"
                  >
                    <i class="fas fa-folder-tree text-amber-400 text-xs"></i>
                    <i class="fas fa-caret-down text-[10px]"></i>
                  </button>

                </div>

                <!-- Right Action Buttons -->
                <div class="flex items-center gap-1.5">
                  <!-- Test Single Connection -->
                  <button
                    v-if="conn.type === 'SSH'"
                    @click.stop="handleTestSingleConnection(conn)"
                    :disabled="isBatchEditMode || getSingleTestButtonInfo(conn.id, conn.type).disabled"
                    class="h-7 px-2 text-xs rounded-md border border-border/60 hover:bg-muted text-foreground flex items-center gap-1 transition-colors disabled:opacity-40"
                    :title="getSingleTestButtonInfo(conn.id, conn.type).title"
                  >
                    <i :class="[getSingleTestButtonInfo(conn.id, conn.type).iconClass, 'text-xs']"></i>
                  </button>

                  <!-- Edit Connection -->
                  <button
                    @click.stop="openEditConnectionForm(conn)"
                    :disabled="isBatchEditMode"
                    class="h-7 px-2 text-xs rounded-md border border-border/60 hover:bg-muted text-foreground flex items-center gap-1 transition-colors disabled:opacity-40"
                    :title="t('connections.actions.edit')"
                  >
                    <i class="fas fa-pencil-alt text-xs"></i>
                  </button>

                  <!-- Connect Button (Main Action) -->
                  <button
                    @click.stop="connectTo(conn)"
                    :disabled="isBatchEditMode"
                    class="h-7 px-3 bg-primary text-white text-xs font-semibold rounded-md shadow-xs hover:bg-primary-hover flex items-center gap-1.5 transition-colors disabled:opacity-40"
                  >
                    <i class="fas fa-play text-[10px]"></i>
                    <span>{{ t('connections.actions.connect', '连接') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Empty State -->
          <div v-else class="flex flex-col items-center justify-center h-64 text-text-secondary text-sm">
            <i class="fas fa-folder-open text-4xl mb-3 opacity-30"></i>
            <p v-if="searchQuery" class="text-xs">{{ t('dashboard.noConnectionsMatchSearch', '没有主机匹配搜索条件') }}</p>
            <p v-else-if="activeFolder !== 'all'" class="text-xs">{{ t('folders.emptyFolder', '该文件夹下暂无主机') }}</p>
            <p v-else class="text-xs">{{ t('dashboard.noConnections', '没有连接记录') }}</p>
            <button
              @click="openAddConnectionForm"
              class="mt-3 px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-xs font-semibold hover:bg-primary/20 transition-colors"
            >
              <i class="fas fa-plus mr-1"></i>
              <span>创建连接</span>
            </button>
          </div>
        </div>
      </main>
    </div>

    <!-- 放在 body 下，避开批量栏动画创建的层叠上下文以及主机列表的 overflow 裁切。 -->
    <Teleport to="body">
      <div
        v-if="activeMoveMenu !== null"
        ref="moveMenuRef"
        class="fixed z-[9500] bg-popover text-foreground border border-border rounded-xl shadow-xl p-1 text-xs overflow-y-auto overscroll-contain"
        :style="moveMenuStyle"
        @click.stop
      >
        <div v-if="activeMoveMenu !== 'batch'" class="px-2 py-1 text-[10px] text-text-secondary font-semibold uppercase tracking-wider">
          {{ t('folders.moveToFolder', '移至文件夹') }}
        </div>
        <button
          type="button"
          @click="selectMoveFolder(null)"
          class="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-muted text-text-secondary hover:text-foreground flex items-center gap-2"
        >
          <i class="fas fa-inbox text-xs"></i>
          <span>{{ t('folders.uncategorized', '未分类') }}</span>
        </button>
        <div v-if="folders.length > 0" class="h-px bg-border/40 my-1"></div>
        <button
          v-for="folder in folders"
          :key="folder.id"
          type="button"
          @click="selectMoveFolder(folder.id)"
          class="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-muted text-foreground flex items-center gap-2"
        >
          <i class="fas fa-folder text-amber-400 text-xs"></i>
          <span class="truncate">{{ folder.name }}</span>
        </button>
      </div>
    </Teleport>

    <!-- Modals -->
    <AddConnectionForm
      v-if="showAddEditConnectionForm"
      :connectionToEdit="connectionToEdit"
      @close="handleFormClose"
      @connection-added="handleConnectionModified"
      @connection-updated="handleConnectionModified"
    />

    <BatchEditConnectionForm
      v-if="showBatchEditForm"
      :visible="showBatchEditForm"
      :connection-ids="Array.from(selectedConnectionIdsForBatch)"
      @update:visible="handleBatchEditFormClose"
      @saved="handleBatchEditSaved"
    />
  </div>
</template>

<style scoped>
.connection-colored-card:hover {
  background-color: var(--conn-card-hover-bg, var(--conn-card-bg)) !important;
  border-color: var(--conn-card-border) !important;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.animate-fadeIn {
  animation: fadeIn 0.15s ease-out forwards;
}
</style>