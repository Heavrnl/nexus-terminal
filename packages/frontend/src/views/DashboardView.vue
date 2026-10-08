<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import AddConnectionForm from '../components/AddConnectionForm.vue'; 
import MobileDashboard from '../components/MobileDashboard.vue';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { hexToRgba } from '../utils/colorUtils';
import { useConnectionsStore } from '../stores/connections.store';
import { useAuditLogStore } from '../stores/audit.store';
import { useSessionStore } from '../stores/session.store';
import { useTagsStore } from '../stores/tags.store'; 
import type { TagInfo } from '../stores/tags.store'; 

import type { SortField, SortOrder } from '../stores/settings.store'; 
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { ConnectionInfo } from '../stores/connections.store';
import { storeToRefs } from 'pinia'; 
import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS, ja } from 'date-fns/locale';
import type { Locale } from 'date-fns';

const { t, locale } = useI18n();
const router = useRouter();
const { isMobile } = useDeviceDetection();
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);

const handleResize = () => {
  windowWidth.value = window.innerWidth;
};

const isMobileMode = computed(() => isMobile.value || windowWidth.value < 768);

const connectionsStore = useConnectionsStore();
const auditLogStore = useAuditLogStore();
const sessionStore = useSessionStore();
const tagsStore = useTagsStore(); 


const { connections, isLoading: isLoadingConnections } = storeToRefs(connectionsStore);
const { logs: auditLogs, isLoading: isLoadingLogs, totalLogs } = storeToRefs(auditLogStore);
const { tags, isLoading: isLoadingTags } = storeToRefs(tagsStore); 



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

const LS_SORT_BY_KEY = 'dashboard_connections_sort_by';
const LS_SORT_ORDER_KEY = 'dashboard_connections_sort_order';
const LS_FILTER_TAG_KEY = 'dashboard_connections_filter_tag'; 

// Initialize with localStorage values or defaults
const localSortBy = ref<SortField>(localStorage.getItem(LS_SORT_BY_KEY) as SortField || 'last_connected_at');
const localSortOrder = ref<SortOrder>(localStorage.getItem(LS_SORT_ORDER_KEY) as SortOrder || 'desc');
// +++ 初始化标签筛选状态，从 localStorage 读取，注意类型转换 (修正 ref 初始化) +++
const getInitialSelectedTagId = (): number | null => {
  const storedValue = localStorage.getItem(LS_FILTER_TAG_KEY);
  // 如果存储的值是 'null' 字符串或空，则返回 null，否则解析为数字
  return storedValue && storedValue !== 'null' ? parseInt(storedValue, 10) : null;
};
const selectedTagId = ref<number | null>(getInitialSelectedTagId());
const searchQuery = ref('');

// +++ 控制添加/编辑表单的显示状态 +++
const showAddEditConnectionForm = ref(false);
const connectionToEdit = ref<ConnectionInfo | null>(null);

const maxRecentLogs = 5;
 
const sortOptions: { value: SortField; labelKey: string }[] = [
  { value: 'last_connected_at', labelKey: 'dashboard.sortOptions.lastConnected' },
  { value: 'name', labelKey: 'dashboard.sortOptions.name' },
  { value: 'type', labelKey: 'dashboard.sortOptions.type' },
  { value: 'updated_at', labelKey: 'dashboard.sortOptions.updated' },
  { value: 'created_at', labelKey: 'dashboard.sortOptions.created' },
];

// +++ 修改计算属性，先筛选再排序 +++
const filteredAndSortedConnections = computed(() => {
  const sortBy = localSortBy.value;
  const sortOrderVal = localSortOrder.value;
  const factor = sortOrderVal === 'desc' ? -1 : 1;
  const filterTagId = selectedTagId.value;
  const query = searchQuery.value.toLowerCase().trim(); // +++ 获取搜索查询 +++
 
  // 1. Filter by selected tag
  let filteredByTag = filterTagId === null
    ? [...connections.value] // No tag selected, show all
    : connections.value.filter(conn => conn.tag_ids?.includes(filterTagId));
 
  // 2. Filter by search query
  let searchedConnections = filteredByTag;
  if (query) {
    searchedConnections = filteredByTag.filter(conn => {
      const nameMatch = conn.name?.toLowerCase().includes(query);
      const usernameMatch = conn.username?.toLowerCase().includes(query);
      const hostMatch = conn.host?.toLowerCase().includes(query);
      const portMatch = conn.port?.toString().includes(query);
      return nameMatch || usernameMatch || hostMatch || portMatch;
    });
  }
 
  // 3. Sort the searched connections
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

const recentAuditLogs = computed(() => {
  return auditLogs.value.slice(0, maxRecentLogs);
});

onMounted(async () => {
  // Load saved preferences from localStorage (already done during ref initialization)

  // Fetch connections if not already loaded
  if (connections.value.length === 0) {
    try {
      await connectionsStore.fetchConnections();
    } catch (error) {
      console.error("加载连接列表失败:", error);
    }
  }

  // Fetch recent audit logs
  try {
    await auditLogStore.fetchLogs({
        page: 1,
        limit: maxRecentLogs,
        sortOrder: 'desc',
        isDashboardRequest: true
    });
  } catch (error) {
    console.error("加载审计日志失败:", error);
  }

  // +++ Fetch tags for filtering +++
  try {
    await tagsStore.fetchTags();
  } catch (error) {
    console.error("加载标签列表失败:", error);
  }
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
});

const connectTo = (connection: ConnectionInfo) => {
  sessionStore.handleConnectRequest(connection);
};

const toggleSortOrder = () => {
  // Only update the local sort order state
  localSortOrder.value = localSortOrder.value === 'asc' ? 'desc' : 'asc';
};

const isAscending = computed(() => localSortOrder.value === 'asc'); // Use local state

// Watch for changes in local sort state and save to localStorage
watch(localSortBy, (newValue) => {
  localStorage.setItem(LS_SORT_BY_KEY, newValue);
});

watch(localSortOrder, (newValue) => {
  localStorage.setItem(LS_SORT_ORDER_KEY, newValue);
});

// +++ Watch for changes in selected tag and save to localStorage +++
watch(selectedTagId, (newValue) => {
  // Store 'null' as a string or the number
  localStorage.setItem(LS_FILTER_TAG_KEY, newValue === null ? 'null' : String(newValue));
});

const dateFnsLocales: Record<string, Locale> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': ja,
  // 主语言回退
  'en': enUS,
  'zh': zhCN,
  'ja': ja,
};

// 修正函数签名，接受 number | null | undefined
const formatRelativeTime = (timestampInSeconds: number | null | undefined): string => {
  if (!timestampInSeconds) return t('connections.status.never');
  try {
    // 将秒级时间戳转换为毫秒级
    const timestampInMs = timestampInSeconds * 1000;
    // 检查转换后的值是否有效
    if (isNaN(timestampInMs)) {
        console.warn(`[Dashboard] Invalid timestamp received: ${timestampInSeconds}`);
        return String(timestampInSeconds); // 返回原始值或错误提示
    }
    const date = new Date(timestampInMs);

    const currentI18nLocale = locale.value; // 获取 vue-i18n 当前 locale (e.g., 'zh-CN')
    const langPart = currentI18nLocale.split('-')[0]; // 获取主语言部分 (e.g., 'zh')

    // 1. 尝试精确匹配 (e.g., 'zh-CN' -> zhCN)
    let targetDateFnsLocale = dateFnsLocales[currentI18nLocale];

    // 2. 如果无精确匹配，尝试匹配主语言 (e.g., 'zh' -> zhCN)
    if (!targetDateFnsLocale) {
      targetDateFnsLocale = dateFnsLocales[langPart];
    }

    // 3. 如果仍然找不到，回退到默认 enUS
    if (!targetDateFnsLocale) {
      console.warn(`[Dashboard] date-fns locale not found for ${currentI18nLocale} or ${langPart}. Falling back to en-US.`);
      targetDateFnsLocale = enUS; // 默认回退到 enUS
    }

    return formatDistanceToNow(date, { addSuffix: true, locale: targetDateFnsLocale });
  } catch (e) {
    console.error("格式化日期失败:", e);
    return String(timestampInSeconds); // 出错时返回原始字符串
  }
};

const getActionTranslation = (actionType: string): string => {
  // 尝试从 i18n 获取翻译，如果找不到则返回原始 actionType
  const key = `auditLog.actions.${actionType}`;
  const translated = t(key);
  // 如果翻译结果等于 key 本身，说明没有找到翻译
  return translated === key ? actionType : translated;
};

// 辅助函数：判断活动类型是否表示失败
const isFailedAction = (actionType: string): boolean => {
  const lowerCaseAction = actionType.toLowerCase();
  // 检查常见的失败关键词
  return lowerCaseAction.includes('fail') || lowerCaseAction.includes('error') || lowerCaseAction.includes('denied');
};

// +++ 恢复：根据 tag_ids 获取标签名称数组 +++
const getTagNames = (tagIds: number[] | undefined): string[] => {
  if (!tagIds || tagIds.length === 0) {
    return [];
  }
  const allTags = tags.value as TagInfo[];
  return tagIds
    .map(id => allTags.find(tag => tag.id === id)?.name)
    .filter((name): name is string => !!name); // 过滤掉未找到的标签并确保类型为 string
};

// +++ 打开添加表单 +++
const openAddConnectionForm = () => {
  connectionToEdit.value = null;
  showAddEditConnectionForm.value = true;
};

// +++ 打开编辑表单 +++
const openEditConnectionForm = (conn: ConnectionInfo) => {
  connectionToEdit.value = conn;
  showAddEditConnectionForm.value = true;
};

// +++ 处理表单关闭事件 +++
const handleFormClose = () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null; // 清除编辑状态
};

// +++ 处理连接添加/更新成功事件 +++
const handleConnectionModified = async () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null;
  await connectionsStore.fetchConnections(); // 重新加载连接列表
};
 
// --- 移除 selectTagFilter 函数 ---
 
</script>

<template>
  <!-- 移动端特化版本 -->
  <MobileDashboard v-if="isMobileMode" />

  <!-- 桌面端视图（保持原逻辑与布局 100% 不变） -->
  <div v-else class="p-4 md:p-6 lg:p-8 bg-background text-foreground">
    <h1 class="text-2xl font-semibold mb-6">{{ t('nav.dashboard') }}</h1>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:items-start">

      <!-- Connection List -->
      <div class="bg-card text-card-foreground shadow rounded-lg overflow-hidden border border-border min-h-[400px]">
        <div class="px-4 py-3 border-b border-border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
          <h2 class="text-lg font-medium flex-shrink-0">{{ t('dashboard.connectionList', '连接列表') }} ({{ filteredAndSortedConnections.length }})</h2>
          <div class="w-full sm:w-auto flex flex-wrap sm:flex-nowrap items-stretch sm:items-center space-y-2 sm:space-y-0 sm:space-x-2">
            <!-- Search Input (Order adjusted for button placement) -->
            <input
              type="text"
              v-model="searchQuery"
              :placeholder="t('dashboard.searchConnectionsPlaceholder', '搜索连接...')"
              class="h-8 px-3 py-1 text-sm border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary w-full sm:w-48"
            />
            <div class="flex items-center space-x-2"> <!-- Wrapper for existing controls -->
             <!-- Tag Filter Dropdown -->
             <select
                v-model="selectedTagId"
                class="h-8 px-2 py-1 text-sm border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary appearance-none bg-no-repeat bg-right pr-8"
                style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.5rem center; background-size: 16px 12px;"
                aria-label="Filter connections by tag"
                :disabled="isLoadingTags"
              >
                <option :value="null">{{ t('dashboard.filterTags.all', '所有标签') }}</option>
                <option v-if="isLoadingTags" disabled>{{ t('common.loading') }}</option>
                <!-- 修正 v-for 循环中的类型 -->
                <option v-for="tag in (tags as TagInfo[])" :key="tag.id" :value="tag.id">
                  {{ tag.name }}
                </option>
              </select>

             <!-- Sort By Dropdown -->
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

              <!-- Sort Order Button -->
              <button
                @click="toggleSortOrder"
                class="h-8 px-1.5 py-1 border border-border rounded hover:bg-muted focus:outline-none focus:ring-1 focus:ring-primary flex items-center justify-center"
                :aria-label="isAscending ? t('common.sortAscending') : t('common.sortDescending')"
                :title="isAscending ? t('common.sortAscending') : t('common.sortDescending')"
              >
                <i :class="['fas', isAscending ? 'fa-arrow-up-a-z' : 'fa-arrow-down-z-a', 'w-4 h-4']"></i>
              </button>
            </div>
            <!-- Add Connection Button -->
            <button @click="openAddConnectionForm" title="Add Connection" class="h-8 w-8 bg-button rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out flex items-center justify-center flex-shrink-0 ml-2 sm:ml-0">
              <i class="fas fa-plus" style="color: white;"></i>
            </button>
          </div>
        </div>
        <div class="p-4">
          <!-- Use filteredAndSortedConnections and check its length -->
          <div v-if="isLoadingConnections && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary">{{ t('common.loading') }}</div>
          <ul v-else-if="filteredAndSortedConnections.length > 0" class="space-y-3">
            <!-- Iterate over filteredAndSortedConnections -->
            <li
              v-for="conn in filteredAndSortedConnections"
              :key="conn.id"
              class="flex items-center justify-between p-3 rounded transition duration-150 ease-in-out border"
              :class="conn.background_color ? 'connection-colored-card shadow-xs' : 'bg-header/50 border-border/50 hover:bg-header/70'"
              :style="getConnectionCardStyle(conn.background_color)"
            >
              <div class="flex-grow mr-4 overflow-hidden">
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
                <span class="text-xs text-text-alt block mb-1"> <!-- Added margin-bottom -->
                  {{ t('dashboard.lastConnected', '上次连接:') }} {{ formatRelativeTime(conn.last_connected_at) }}
                </span>
                <div v-if="getTagNames(conn.tag_ids).length > 0" class="flex flex-wrap gap-1 mt-1">
                  <span
                    v-for="tagName in getTagNames(conn.tag_ids)"
                    :key="tagName"
                    class="px-1.5 py-0.5 text-xs rounded bg-muted text-muted-foreground border border-border"
                  >
                    {{ tagName }}
                  </span>
                </div>
              </div>
              <div class="flex space-x-2 flex-shrink-0">
                <button @click="openEditConnectionForm(conn)" class="px-3 py-1.5 bg-transparent text-foreground border border-border rounded-md shadow-sm hover:bg-border focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                  <i class="fas fa-pencil-alt"></i>
                </button>
                <button @click="connectTo(conn)" class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium"> <!-- Applied standard button style -->
                  {{ t('connections.actions.connect') }}
                </button>
              </div>
            </li>
          </ul>
          <!-- Adjust no connections message based on filtering and search -->
          <div v-else-if="!isLoadingConnections && searchQuery && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary">{{ t('dashboard.noConnectionsMatchSearch', '没有连接匹配搜索条件') }}</div>
          <div v-else-if="!isLoadingConnections && selectedTagId !== null && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary">{{ t('dashboard.noConnectionsWithTag', '该标签下没有连接记录') }}</div>
          <div v-else class="text-center text-text-secondary">{{ t('dashboard.noConnections', '没有连接记录') }}</div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="bg-card text-card-foreground shadow rounded-lg overflow-hidden border border-border min-h-[400px]">
        <div class="px-4 py-3 border-b border-border">
          <h2 class="text-lg font-medium">{{ t('dashboard.recentActivity', '最近活动') }}</h2>
        </div>
        <div class="p-4">
          <!-- Loading State (Only show if loading AND no logs are displayed yet) -->
          <div v-if="isLoadingLogs && recentAuditLogs.length === 0" class="text-center text-text-secondary">{{ t('common.loading') }}</div>
          <ul v-else-if="recentAuditLogs.length > 0" class="space-y-3">
            <li v-for="log in recentAuditLogs" :key="log.id" class="p-3 bg-header/50 border border-border/50 rounded"> <!-- Applied audit log item style -->
              <div class="flex justify-between items-start mb-1">
                <span class="font-medium text-sm" :class="{ 'text-error': isFailedAction(log.action_type) }">{{ getActionTranslation(log.action_type) }}</span>
                <span class="text-xs text-text-alt flex-shrink-0 ml-2">{{ formatRelativeTime(log.timestamp) }}</span>
              </div>
              <p class="text-sm text-text-secondary break-words">{{ log.details }}</p>
            </li>
          </ul>
          <div v-else class="text-center text-text-secondary">{{ t('dashboard.noRecentActivity', '没有最近活动记录') }}</div>
        </div>
        <div class="px-4 py-3 border-t border-border text-right">
          <RouterLink :to="{ name: 'AuditLogs' }" class="text-sm text-link hover:text-link-hover hover:underline">
            {{ t('dashboard.viewFullAuditLog', '查看完整审计日志') }}
          </RouterLink>
        </div>
      </div>

    </div>
    <!-- Add/Edit Connection Form Modal -->
    <AddConnectionForm
      v-if="showAddEditConnectionForm"
      :connectionToEdit="connectionToEdit"
      :is-mobile="false"
      @close="handleFormClose"
      @connection-added="handleConnectionModified"
      @connection-updated="handleConnectionModified"
    />
  </div>
</template>
<style scoped>
.connection-colored-card:hover {
  background-color: var(--conn-card-hover-bg, var(--conn-card-bg)) !important;
  border-color: var(--conn-card-border) !important;
}
</style>
