<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import AddConnectionForm from '../components/AddConnectionForm.vue';
import BatchEditConnectionForm from '../components/BatchEditConnectionForm.vue';
import { hexToRgba } from '../utils/colorUtils';
import { useConnectionsStore } from '../stores/connections.store';
import { useSessionStore } from '../stores/session.store';
import { useTagsStore } from '../stores/tags.store';
import type { TagInfo } from '../stores/tags.store';
import type { SortField, SortOrder } from '../stores/settings.store';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { ConnectionInfo } from '../stores/connections.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog';
import { storeToRefs } from 'pinia';
import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS, ja } from 'date-fns/locale';
import type { Locale } from 'date-fns';

const { t, locale } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog();
const connectionsStore = useConnectionsStore();
const sessionStore = useSessionStore();
const tagsStore = useTagsStore();

const { connections, isLoading: isLoadingConnections } = storeToRefs(connectionsStore);
const { tags, isLoading: isLoadingTags } = storeToRefs(tagsStore);

const LS_SORT_BY_KEY = 'connections_view_sort_by';
const LS_SORT_ORDER_KEY = 'connections_view_sort_order';
const LS_FILTER_TAG_KEY = 'connections_view_filter_tag';

const localSortBy = ref<SortField>(localStorage.getItem(LS_SORT_BY_KEY) as SortField || 'last_connected_at');
const localSortOrder = ref<SortOrder>(localStorage.getItem(LS_SORT_ORDER_KEY) as SortOrder || 'desc');

const getInitialSelectedTagId = (): number | null => {
  const storedValue = localStorage.getItem(LS_FILTER_TAG_KEY);
  return storedValue && storedValue !== 'null' ? parseInt(storedValue, 10) : null;
};
const selectedTagId = ref<number | null>(getInitialSelectedTagId());
const searchQuery = ref('');

const showAddEditConnectionForm = ref(false);
const connectionToEdit = ref<ConnectionInfo | null>(null);

// Batch Edit Mode
const isBatchEditMode = ref(false);
const selectedConnectionIdsForBatch = ref<Set<number>>(new Set());
const showBatchEditForm = ref(false);
const isDeletingSelectedConnections = ref(false);

const getConnectionCardStyle = (backgroundColor?: string | null) => {
  if (!backgroundColor) return {};
  return {
    '--conn-card-bg': hexToRgba(backgroundColor, 0.14),
    '--conn-card-hover-bg': hexToRgba(backgroundColor, 0.22),
    '--conn-card-border': hexToRgba(backgroundColor, 0.32),
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

const filteredAndSortedConnections = computed(() => {
  const sortBy = localSortBy.value;
  const sortOrderVal = localSortOrder.value;
  const factor = sortOrderVal === 'desc' ? -1 : 1;
  const filterTagId = selectedTagId.value;
  const query = searchQuery.value.toLowerCase().trim();

  let filteredByTag = filterTagId === null
    ? [...connections.value]
    : connections.value.filter(conn => conn.tag_ids?.includes(filterTagId));

  let searchedConnections = filteredByTag;
  if (query) {
    searchedConnections = filteredByTag.filter(conn => {
      const nameMatch = conn.name?.toLowerCase().includes(query);
      const usernameMatch = conn.username?.toLowerCase().includes(query);
      const hostMatch = conn.host?.toLowerCase().includes(query);
      const portMatch = conn.port?.toString().includes(query);
      const notesMatch = conn.notes?.toLowerCase().includes(query); // 添加对备注的搜索
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

onMounted(async () => {
  if (connections.value.length === 0) {
    try {
      await connectionsStore.fetchConnections();
    } catch (error) {
      console.error("加载连接列表失败:", error);
    }
  }
  try {
    await tagsStore.fetchTags();
  } catch (error) {
    console.error("加载标签列表失败:", error);
  }
});

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

watch(selectedTagId, (newValue) => {
  localStorage.setItem(LS_FILTER_TAG_KEY, newValue === null ? 'null' : String(newValue));
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
    if (isNaN(timestampInMs)) {
        console.warn(`[ConnectionsView] Invalid timestamp received: ${timestampInSeconds}`);
        return String(timestampInSeconds);
    }
    const date = new Date(timestampInMs);
    const currentI18nLocale = locale.value;
    const langPart = currentI18nLocale.split('-')[0];
    let targetDateFnsLocale = dateFnsLocales[currentI18nLocale] || dateFnsLocales[langPart] || enUS;
    return formatDistanceToNow(date, { addSuffix: true, locale: targetDateFnsLocale });
  } catch (e) {
    console.error("格式化日期失败:", e);
    return String(timestampInSeconds);
  }
};

const getTagNames = (tagIds: number[] | undefined): string[] => {
  if (!tagIds || tagIds.length === 0) {
    return [];
  }
  const allTags = tags.value as TagInfo[];
  return tagIds
    .map(id => allTags.find(tag => tag.id === id)?.name)
    .filter((name): name is string => !!name);
};

const openAddConnectionForm = () => {
  connectionToEdit.value = null;
  showAddEditConnectionForm.value = true;
};

const openEditConnectionForm = (conn: ConnectionInfo) => {
  connectionToEdit.value = conn;
  showAddEditConnectionForm.value = true;
};

const handleFormClose = () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null;
};

const handleConnectionModified = async () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null;
  await connectionsStore.fetchConnections();
};

// --- Batch Edit Functions ---
const toggleBatchEditMode = () => {
  isBatchEditMode.value = !isBatchEditMode.value;
  if (!isBatchEditMode.value) {
    selectedConnectionIdsForBatch.value.clear(); // Clear selection when exiting batch mode
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
    // Optionally, show a notification from uiNotificationsStore using your project's method
    showAlertDialog({ title: t('common.alert', '提示'), message: t('connections.batchEdit.noSelectionForEdit', '请至少选择一个连接进行编辑。') }); // Placeholder
    return;
  }
  showBatchEditForm.value = true;
};

const handleBatchEditSaved = async () => {
  showBatchEditForm.value = false;
  selectedConnectionIdsForBatch.value.clear();
  // isBatchEditMode.value = false; // Optionally exit batch mode after saving
  await connectionsStore.fetchConnections(); // Refresh the list
};

const handleBatchEditFormClose = () => {
  showBatchEditForm.value = false;
};

// --- 批量删除 ---
const handleBatchDeleteConnections = async () => {
  if (selectedConnectionIdsForBatch.value.size === 0 || isDeletingSelectedConnections.value) {
    return;
  }

  const confirmMessage = t(
    'connections.batchEdit.confirmMessage',
    { count: selectedConnectionIdsForBatch.value.size },
    `您确定要删除选中的 ${selectedConnectionIdsForBatch.value.size} 个连接吗？此操作无法撤销。`
  );


  const confirmed = await showConfirmDialog({
    message: confirmMessage
  });
  if (confirmed) {
    isDeletingSelectedConnections.value = true;
    try {
      const idsToDelete = Array.from(selectedConnectionIdsForBatch.value);
      await connectionsStore.deleteBatchConnections(idsToDelete);


      showAlertDialog({ title: t('common.success', '成功'), message: t('connections.batchEdit.successMessage', '选中的连接已成功删除。') });

      selectedConnectionIdsForBatch.value.clear();

      await connectionsStore.fetchConnections();
    } catch (error: any) {
      console.error("Batch delete connections error:", error);
      showAlertDialog({ title: t('common.error'), message: t('connections.batchEdit.errorMessage', `批量删除连接失败: ${error.message || '未知错误'}`) });
    } finally {
      isDeletingSelectedConnections.value = false;
    }
  }
};

// --- Test Connection Logic ---
interface ConnectionTestState {
  status: 'idle' | 'testing' | 'success' | 'error';
  resultText: string;
  latency?: number;
  latencyColor?: string;
}
const connectionTestStates = ref<Map<number, ConnectionTestState>>(new Map());
const isTestingAll = ref(false);

const getLatencyColorString = (latencyMs?: number): string => {
  if (latencyMs === undefined) return 'inherit'; // Default or inherit
  // These colors should ideally come from theme variables if available
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
    // Pass only the ID to testConnection, as per store definition
    const result = await connectionsStore.testConnection(conn.id);

    if (result.success) {
      const latencyMs = result.latency;
      let displayText = ''; // 初始化为空字符串，符合只显示延迟的要求
      let determinedColor;

      if (latencyMs !== undefined) {
        displayText = `${latencyMs}ms`;
        determinedColor = getLatencyColorString(latencyMs);
      } else {
        // 测试成功，但没有延迟信息。不显示文本。
        // 颜色应为明确的成功颜色。
        // getLatencyColorString(0) 会返回绿色，代表非常好的情况。
        determinedColor = getLatencyColorString(0); // 或者直接使用 'var(--color-success, #4CAF50)'
      }

      connectionTestStates.value.set(conn.id, {
        status: 'success',
        resultText: displayText, // 将显示 "XXms" 或者为空
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
  // Ensure conn.id exists for map function and error handling
  const sshConnectionsToTest = filteredAndSortedConnections.value.filter(c => c.type === 'SSH' && c.id != null);
  if (sshConnectionsToTest.length === 0) {
    // Optionally notify user that there are no SSH connections to test
    // Consider using uiNotificationsStore from your project for a user-friendly message
    return;
  }

  isTestingAll.value = true;
  const testPromises = sshConnectionsToTest.map(conn => {
    // conn.id is guaranteed to exist here due to the filter above.
    // We're calling handleTestSingleConnection for each.
    // Individual errors within handleTestSingleConnection will update that specific connection's state.
    // We also add a .catch here to handle any unexpected errors from handleTestSingleConnection itself
    // or if conn.id was somehow null/undefined (though filtered out).
    return handleTestSingleConnection(conn).catch(error => {
      console.error(`Error testing connection ${conn.id}:`, error);
      // Ensure state is updated for this specific connection to show an error
      // The 'id' here is from the 'conn' object in the map function's scope.
      connectionTestStates.value.set(conn.id!, { // Using non-null assertion as id is checked
        status: 'error',
        resultText: t('connections.test.unknownErrorDuringBatch', '批量测试中发生错误'), // New i18n key
      });
    });
  });

  try {
    await Promise.all(testPromises);
  } catch (error) {
    // This catch block handles errors if Promise.all itself fails,
    // though individual promise rejections are handled above.
    console.error("Error during batch testing of connections (Promise.all):", error);
    // Optionally, set a general error state or notification for the entire batch operation if needed.
  } finally {
    isTestingAll.value = false;
  }
};

const getSingleTestButtonInfo = (connId: number | undefined, connType: string | undefined) => {
  const state = connId ? connectionTestStates.value.get(connId) : undefined;

  if (connType !== 'SSH') {
    return {
      textKey: 'connections.actions.test',
      iconClass: 'fas fa-plug',
      disabled: true,
      loading: false,
      title: t('connections.test.onlySshSupportedTest', '仅SSH连接支持测试。')
    };
  }
  if (!connId) { // Should not happen if connType is SSH and we are in the list
     return { textKey: 'connections.actions.test', iconClass: 'fas fa-plug', disabled: true, loading: false, title: '' };
  }

  if (state?.status === 'testing') {
    return { textKey: 'connections.actions.testing', iconClass: 'fas fa-spinner fa-spin', disabled: true, loading: true, title: t('connections.actions.testing', '测试中') };
  }
  if (state?.status === 'success' || state?.status === 'error') {
    // 测试完成后，按钮恢复为初始“测试”状态
    return { textKey: 'connections.actions.test', iconClass: 'fas fa-plug', disabled: false, loading: false, title: t('connections.actions.test', '测试') };
  }
  // 默认状态也是“测试”
  return { textKey: 'connections.actions.test', iconClass: 'fas fa-plug', disabled: false, loading: false, title: t('connections.actions.test', '测试') };
};

const getTruncatedNotes = (notes: string | null | undefined): string => {
  if (!notes || notes.trim() === '') return ''; // 返回空字符串，如果没有备注
  const maxLength = 100;
  if (notes.length <= maxLength) return notes;
  return notes.substring(0, maxLength) + '...';
};



// --- Connect All Filtered Connections ---
const isConnectingAll = ref(false);

const handleConnectAllFilteredConnections = async () => {
  if (isConnectingAll.value || isLoadingConnections.value) return;

  const sshConnectionsToConnect = filteredAndSortedConnections.value.filter(conn => conn.type === 'SSH');
  if (sshConnectionsToConnect.length === 0) {
    console.warn(t('connections.messages.noSshConnectionsToConnectAll', '没有可连接的 SSH 筛选结果。'));
    // Optionally, use a UI notification if available in your project
    // e.g., uiNotificationsStore.addNotification({ message: t('connections.messages.noSshConnectionsToConnectAll'), type: 'info' });
    return;
  }

  isConnectingAll.value = true;
  try {
    for (const conn of sshConnectionsToConnect) {
      connectTo(conn);
      // Consider a small delay if you want to visually see connections initiating one by one,
      // or if connectTo triggers operations that might benefit from not being fired too rapidly.
      // await new Promise(resolve => setTimeout(resolve, 200)); // Example delay
    }
  } catch (error) {
    console.error("Error connecting to all filtered SSH connections:", error);
    // uiNotificationsStore.addNotification({ message: t('connections.errors.connectAllSshFailed', '连接全部 SSH 操作失败。'), type: 'error' });
  } finally {
    isConnectingAll.value = false;
  }
};

</script>

<template>
  <div class="p-4 md:p-6 lg:p-8 bg-background text-foreground"> <!-- 最外层，负责背景和整体内边距 -->
    <div class="max-w-screen-lg mx-auto"> <!-- 将 xl 修改为 lg -->
      <h1 class="text-2xl font-semibold mb-6">{{ t('nav.connections', '连接管理') }}</h1>

      <div class="bg-card text-card-foreground shadow rounded-lg overflow-hidden border border-border min-h-[400px]"> <!-- 移除了 max-w-screen-2xl mx-auto -->
        <div class="px-4 py-3 border-b border-border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <h2 class="text-lg font-medium flex-shrink-0">{{ t('dashboard.connectionList', '连接列表') }} ({{ filteredAndSortedConnections.length }})</h2>
        <div class="w-full sm:w-auto flex flex-wrap sm:flex-nowrap items-stretch sm:items-center space-y-2 sm:space-y-0 sm:space-x-2">
          <!-- Batch Edit Toggle -->
          <div class="flex items-center mr-3">
            <label for="batch-edit-toggle" class="mr-2 text-sm font-medium text-text-secondary">{{ t('connections.batchEdit.toggleLabel', '批量修改') }}</label>
            <button
              id="batch-edit-toggle"
              @click="toggleBatchEditMode"
              :class="[
                'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
                isBatchEditMode ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
              ]"
              role="switch"
              :aria-checked="isBatchEditMode"
            >
              <span
                aria-hidden="true"
                :class="[
                  'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
                  isBatchEditMode ? 'translate-x-5' : 'translate-x-0'
                ]"
              ></span>
            </button>
          </div>

          <input
            type="text"
            v-model="searchQuery"
            :placeholder="t('dashboard.searchConnectionsPlaceholder', '搜索连接...')"
            class="h-8 px-3 py-1 text-sm border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary w-full sm:w-48"
          />
          <div class="flex items-center space-x-2">
           <select
              v-model="selectedTagId"
              class="h-8 px-2 py-1 text-sm border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary appearance-none bg-no-repeat bg-right pr-8"
              style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.5rem center; background-size: 16px 12px;"
              aria-label="Filter connections by tag"
              :disabled="isLoadingTags"
            >
              <option :value="null">{{ t('dashboard.filterTags.all', '所有标签') }}</option>
              <option v-if="isLoadingTags" disabled>{{ t('common.loading') }}</option>
              <option v-for="tag in (tags as TagInfo[])" :key="tag.id" :value="tag.id">
                {{ tag.name }}
              </option>
            </select>

           <select
              v-model="localSortBy"
              class="h-8 px-2 py-1 text-sm border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary appearance-none bg-no-repeat bg-right pr-8"
              style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.5rem center; background-size: 16px 12px;"
              aria-label="Sort connections by"
            >
              <option v-for="option in sortOptions" :key="option.value" :value="option.value">
                {{ t(option.labelKey, option.value.replace('_', ' ')) }}
              </option>
            </select>

            <button
              @click="toggleSortOrder"
              class="h-8 px-1.5 py-1 border border-border rounded hover:bg-muted focus:outline-none focus:ring-1 focus:ring-primary flex items-center justify-center"
              :aria-label="isAscending ? t('common.sortAscending') : t('common.sortDescending')"
              :title="isAscending ? t('common.sortAscending') : t('common.sortDescending')"
            >
              <i :class="['fas', isAscending ? 'fa-arrow-up-a-z' : 'fa-arrow-down-z-a', 'w-4 h-4']"></i>
            </button>
          </div>
          <button @click="openAddConnectionForm" :title="t('connections.addConnection', 'Add Connection')" class="h-8 w-8 bg-button rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out flex items-center justify-center flex-shrink-0 ml-2 sm:ml-0">
            <i class="fas fa-plus" style="color: white;"></i>
          </button>
          <!-- Test All Filtered Connections Button -->
          <button
            @click="handleTestAllFilteredConnections"
            :disabled="isTestingAll || isLoadingConnections || !filteredAndSortedConnections.some(c => c.type === 'SSH')"
            class="h-8 px-3 py-1.5 text-sm bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out flex items-center justify-center flex-shrink-0 ml-2 sm:ml-0"
            :title="t('connections.actions.testAllFiltered', '测试全部筛选的SSH连接')"
          >
            <i v-if="isTestingAll" class="fas fa-spinner fa-spin mr-1 sm:mr-2" style="color: white;"></i>
            <i v-else class="fas fa-check-double mr-1 sm:mr-2" style="color: white;"></i>
            <span class="hidden sm:inline">{{ t('connections.actions.testAllFiltered') }}</span>
          </button>
          <!-- Connect All Filtered Connections Button -->
          <button
            @click="handleConnectAllFilteredConnections"
            :disabled="isConnectingAll || isLoadingConnections || !filteredAndSortedConnections.some(c => c.type === 'SSH')"
            class="h-8 px-3 py-1.5 text-sm bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out flex items-center justify-center flex-shrink-0 ml-2 sm:ml-0"
          >
            <i v-if="isConnectingAll" class="fas fa-spinner fa-spin mr-1 sm:mr-2" style="color: white;"></i>
            <i v-else class="fas fa-network-wired mr-1 sm:mr-2" style="color: white;"></i>
            <span class="hidden sm:inline">{{ t('workspaceConnectionList.connectAllSshInGroupMenu', '连接全部') }}</span>
          </button>
        </div>
      </div>

      <!-- Batch Action Buttons -->
      <div v-if="isBatchEditMode" class="px-4 py-2 border-b border-border bg-card flex flex-wrap items-center gap-2">
        <button
          @click="selectAllConnections"
          class="px-3 py-1.5 text-sm bg-transparent text-text-secondary border border-border rounded-md shadow-sm hover:bg-border hover:text-foreground focus:outline-none transition duration-150 ease-in-out"
        >
          {{ t('connections.batchEdit.selectAll', '全选') }} ({{ selectedConnectionIdsForBatch.size }})
        </button>
        <button
          @click="deselectAllConnections"
          class="px-3 py-1.5 text-sm bg-transparent text-text-secondary border border-border rounded-md shadow-sm hover:bg-border hover:text-foreground focus:outline-none transition duration-150 ease-in-out"
        >
          {{ t('connections.batchEdit.deselectAll', '取消全选') }}
        </button>
        <button
          @click="invertSelection"
          class="px-3 py-1.5 text-sm bg-transparent text-text-secondary border border-border rounded-md shadow-sm hover:bg-border hover:text-foreground focus:outline-none transition duration-150 ease-in-out"
        >
          {{ t('connections.batchEdit.invertSelection', '反选') }}
        </button>
        <button
          @click="openBatchEditModal"
          :disabled="selectedConnectionIdsForBatch.size === 0"
          class="px-4 py-1.5 text-sm bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <i class="fas fa-edit mr-1" style="color: white;"></i>
          {{ t('connections.batchEdit.editSelected', '编辑选中') }}
        </button>
        <button
          @click="handleBatchDeleteConnections"
          :disabled="selectedConnectionIdsForBatch.size === 0 || isDeletingSelectedConnections"
          class="px-4 py-1.5 text-sm bg-red-600 text-white rounded-md shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition duration-150 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          :title="t('connections.batchEdit.deleteSelectedTooltip', '删除选中的连接')"
        >
          <i v-if="isDeletingSelectedConnections" class="fas fa-spinner fa-spin mr-1.5" style="color: white;"></i>
          <i v-else class="fas fa-trash-alt mr-1.5" style="color: white;"></i>
          <span>{{ t('connections.batchEdit.deleteSelectedButton', '删除选中') }}</span>
        </button>
      </div>

      <div class="p-4">
        <div v-if="isLoadingConnections && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary">{{ t('common.loading') }}</div>
        <ul v-else-if="filteredAndSortedConnections.length > 0" class="space-y-3">
          <li
            v-for="conn in filteredAndSortedConnections"
            :key="conn.id"
            @click="handleConnectionClick(conn.id)"
            class="flex items-center p-3 rounded transition duration-150 ease-in-out border"
            :class="[
              conn.background_color
                ? 'connection-colored-card shadow-xs'
                : ['bg-header/50 border-border/50', isBatchEditMode ? 'hover:bg-border/70' : 'hover:bg-border/30'],
              { 'ring-2 ring-primary ring-offset-1 ring-offset-background': isBatchEditMode && isConnectionSelectedForBatch(conn.id) },
              { 'cursor-pointer': isBatchEditMode }
            ]"
            :style="getConnectionCardStyle(conn.background_color)"
          >
            <div class="flex-1 min-w-0 mr-3"> <!-- Changed: flex-1 min-w-0 mr-3 -->
              <span class="font-medium block truncate flex items-center" :title="conn.name || ''">
                <i
                  :class="[
                    'fas',
                    conn.type === 'VNC' ? 'fa-plug' : (conn.type === 'RDP' ? 'fa-desktop' : 'fa-server'),
                    'mr-2 w-4 text-center',
                    conn.background_color ? '' : 'text-text-secondary'
                  ]"
                  :style="conn.background_color ? { color: conn.background_color } : {}"
                ></i>
                <span>{{ conn.name || conn.host || t('connections.unnamedFallback', '未命名连接') }}</span>
              </span>
              <span class="text-sm text-text-secondary block truncate" :title="`${conn.username}@${conn.host}:${conn.port}`">
                {{ conn.username }}@{{ conn.host }}:{{ conn.port }}
              </span>
              <span class="text-xs text-text-alt block">
                {{ t('dashboard.lastConnected', '上次连接:') }} {{ formatRelativeTime(conn.last_connected_at) }}
              </span>
              <!-- 备注信息移到这里 -->
              <div v-if="conn.notes && conn.notes.trim() !== ''" class="text-xs text-text-secondary mt-1">
                <span class="font-medium text-text-alt">{{ t('connections.form.notes', '备注:') }}</span>
                <span class="break-words leading-snug ml-1" :title="conn.notes">
                  {{ getTruncatedNotes(conn.notes) }}
                </span>
              </div>
              <div v-if="getTagNames(conn.tag_ids).length > 0" class="flex flex-wrap gap-1 mt-1.5">
                <span
                  v-for="tagName in getTagNames(conn.tag_ids)"
                  :key="tagName"
                  class="px-1.5 py-0.5 text-xs rounded bg-muted text-muted-foreground border border-border"
                >
                  {{ tagName }}
                </span>
              </div>
              <!-- Test Result Display -->
              <div
                v-if="conn.type === 'SSH' && connectionTestStates.get(conn.id) && connectionTestStates.get(conn.id)?.status !== 'idle'"
                class="text-xs mt-1.5 pt-1 border-t border-border/30"
              >
                <div v-if="connectionTestStates.get(conn.id)?.status === 'testing'" class="text-text-secondary animate-pulse flex items-center">
                  <i class="fas fa-spinner fa-spin mr-1.5 text-xs"></i>
                  {{ t('connections.test.testingInProgress', '测试中...') }}
                </div>
                <div
                  v-else-if="connectionTestStates.get(conn.id)?.status === 'success'"
                  class="font-medium flex items-center"
                  :style="{ color: connectionTestStates.get(conn.id)?.latencyColor || 'inherit' }"
                >
                  <i class="fas fa-check-circle mr-1.5 text-xs"></i>
                  {{ connectionTestStates.get(conn.id)?.resultText }}
                </div>
                <div
                  v-else-if="connectionTestStates.get(conn.id)?.status === 'error'"
                  class="text-error font-medium flex items-center"
                >
                  <i class="fas fa-times-circle mr-1.5 text-xs"></i>
                  {{ t('connections.test.errorPrefix', '错误:') }} {{ connectionTestStates.get(conn.id)?.resultText }}
                </div>
              </div>
            </div>
            <!-- 中间备注区域已被移除 -->
            <div class="flex items-center space-x-2 flex-shrink-0">
              <!-- Test Single Connection Button -->
              <button
                v-if="conn.type === 'SSH'"
                @click.stop="handleTestSingleConnection(conn)"
                :disabled="isBatchEditMode || getSingleTestButtonInfo(conn.id, conn.type).disabled"
                class="px-3 py-1.5 bg-transparent text-foreground border border-border rounded-md shadow-sm hover:bg-border focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium h-9 flex items-center justify-center"
                :class="{ 'opacity-50 cursor-not-allowed': isBatchEditMode || getSingleTestButtonInfo(conn.id, conn.type).disabled }"
                :title="getSingleTestButtonInfo(conn.id, conn.type).title"
              >
                <i :class="[getSingleTestButtonInfo(conn.id, conn.type).iconClass, 'w-4 text-center', getSingleTestButtonInfo(conn.id, conn.type).textKey !== 'connections.actions.testing' ? 'mr-1' : '']"></i>
                <span v-if="getSingleTestButtonInfo(conn.id, conn.type).textKey !== 'connections.actions.testing'">{{ t(getSingleTestButtonInfo(conn.id, conn.type).textKey) }}</span>
              </button>
              <button
                @click.stop="openEditConnectionForm(conn)"
                class="px-3 py-1.5 bg-transparent text-foreground border border-border rounded-md shadow-sm hover:bg-border focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium h-9 flex items-center justify-center"
                :disabled="isBatchEditMode"
                :class="{ 'opacity-50 cursor-not-allowed': isBatchEditMode }"
              >
                <i class="fas fa-pencil-alt mr-1"></i>{{ t('connections.actions.edit') }}
              </button>
              <button
                @click.stop="connectTo(conn)"
                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium h-9 flex items-center justify-center"
                :disabled="isBatchEditMode"
                :class="{ 'opacity-50 cursor-not-allowed': isBatchEditMode }"
              >
                {{ t('connections.actions.connect') }}
              </button>
            </div>
          </li>
        </ul>
        <div v-else-if="!isLoadingConnections && searchQuery && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary">{{ t('dashboard.noConnectionsMatchSearch', '没有连接匹配搜索条件') }}</div>
        <div v-else-if="!isLoadingConnections && selectedTagId !== null && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary">{{ t('dashboard.noConnectionsWithTag', '该标签下没有连接记录') }}</div>
        <div v-else class="text-center text-text-secondary">{{ t('dashboard.noConnections', '没有连接记录') }}</div>
        </div>
      </div>
    </div> <!-- 结束新增的包裹层 -->

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
</style>