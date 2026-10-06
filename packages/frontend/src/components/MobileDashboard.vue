<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS, ja } from 'date-fns/locale';
import type { Locale } from 'date-fns';

import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useAuditLogStore } from '../stores/audit.store';
import { useSessionStore } from '../stores/session.store';
import { useTagsStore, type TagInfo } from '../stores/tags.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import AddConnectionForm from './AddConnectionForm.vue';

const { t, locale } = useI18n();
const router = useRouter();

const connectionsStore = useConnectionsStore();
const auditLogStore = useAuditLogStore();
const sessionStore = useSessionStore();
const tagsStore = useTagsStore();
const uiNotificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();

const { connections, isLoading: isLoadingConnections } = storeToRefs(connectionsStore);
const { logs: auditLogs, isLoading: isLoadingLogs } = storeToRefs(auditLogStore);
const { tags, isLoading: isLoadingTags } = storeToRefs(tagsStore);

// 本地存储状态 Key
const LS_SORT_BY_KEY = 'dashboard_mobile_sort_by';
const LS_SORT_ORDER_KEY = 'dashboard_mobile_sort_order';
const LS_ACTIVE_TAB_KEY = 'dashboard_mobile_active_tab';

// 视图与筛选状态
const activeTab = ref<'servers' | 'activity'>((localStorage.getItem(LS_ACTIVE_TAB_KEY) as 'servers' | 'activity') || 'servers');
const searchQuery = ref('');
const selectedTagId = ref<number | null>(null);

type SortOption = 'last_connected_at' | 'name' | 'type' | 'created_at';
const sortBy = ref<SortOption>((localStorage.getItem(LS_SORT_BY_KEY) as SortOption) || 'last_connected_at');
const sortOrder = ref<'asc' | 'desc'>((localStorage.getItem(LS_SORT_ORDER_KEY) as 'asc' | 'desc') || 'desc');

// 浮层与弹窗状态
const isRefreshing = ref(false);
const showSortSheet = ref(false);
const showActionSheet = ref(false);
const selectedConnForAction = ref<ConnectionInfo | null>(null);
const showAddEditModal = ref(false);
const connToEdit = ref<ConnectionInfo | null>(null);
const copiedConnId = ref<number | null>(null);

// 标签映射
const tagMap = computed(() => new Map(tags.value.map(tag => [tag.id, tag.name])));

// 标签列表带“全部”
const allTagItems = computed(() => {
  return [
    { id: null, name: t('dashboard.filterTags.all', '全部') },
    ...(tags.value as TagInfo[])
  ];
});

// 监听状态持久化
watch(activeTab, (val) => {
  localStorage.setItem(LS_ACTIVE_TAB_KEY, val);
});

watch(sortBy, (val) => {
  localStorage.setItem(LS_SORT_BY_KEY, val);
});

watch(sortOrder, (val) => {
  localStorage.setItem(LS_SORT_ORDER_KEY, val);
});

// 排序选项配置
const sortConfig: { value: SortOption; label: string; icon: string }[] = [
  { value: 'last_connected_at', label: '最近连接', icon: 'fa-clock' },
  { value: 'name', label: '连接名称', icon: 'fa-font' },
  { value: 'type', label: '协议类型', icon: 'fa-layer-group' },
  { value: 'created_at', label: '创建时间', icon: 'fa-calendar-plus' },
];

const currentSortLabel = computed(() => {
  const item = sortConfig.find(s => s.value === sortBy.value);
  return item ? item.label : '最近连接';
});

// 过滤和排序连接列表
const filteredAndSortedConnections = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const tagFilter = selectedTagId.value;
  const factor = sortOrder.value === 'desc' ? -1 : 1;

  // 1. 标签与关键词筛选
  let list = connections.value.filter(conn => {
    if (tagFilter !== null) {
      if (!conn.tag_ids || !conn.tag_ids.includes(tagFilter)) {
        return false;
      }
    }

    if (!query) return true;

    const nameMatch = conn.name?.toLowerCase().includes(query);
    const hostMatch = conn.host?.toLowerCase().includes(query);
    const userMatch = conn.username?.toLowerCase().includes(query);
    const portMatch = conn.port?.toString().includes(query);

    let tagMatch = false;
    if (conn.tag_ids && conn.tag_ids.length > 0) {
      for (const tid of conn.tag_ids) {
        const tName = tagMap.value.get(tid);
        if (tName && tName.toLowerCase().includes(query)) {
          tagMatch = true;
          break;
        }
      }
    }

    return nameMatch || hostMatch || userMatch || portMatch || tagMatch;
  });

  // 2. 排序
  return list.sort((a, b) => {
    switch (sortBy.value) {
      case 'name':
        return (a.name || '').localeCompare(b.name || '') * factor;
      case 'type':
        return (a.type || '').localeCompare(b.type || '') * factor;
      case 'created_at':
        return ((a.created_at ?? 0) - (b.created_at ?? 0)) * factor;
      case 'last_connected_at': {
        const timeA = a.last_connected_at ?? (sortOrder.value === 'desc' ? -Infinity : Infinity);
        const timeB = b.last_connected_at ?? (sortOrder.value === 'desc' ? -Infinity : Infinity);
        if (timeA === timeB) return 0;
        return (timeA < timeB ? -1 : 1) * factor;
      }
      default:
        return 0;
    }
  });
});

// 最近审计日志（展示前 15 条）
const recentAuditLogs = computed(() => {
  return auditLogs.value.slice(0, 15);
});

// 日期格式化支持
const dateFnsLocales: Record<string, Locale> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': ja,
  'en': enUS,
  'zh': zhCN,
  'ja': ja,
};

const formatRelativeTime = (timestampInSeconds: number | null | undefined): string => {
  if (!timestampInSeconds) return t('connections.status.never', '从未连接');
  try {
    const timestampInMs = timestampInSeconds * 1000;
    if (isNaN(timestampInMs)) return String(timestampInSeconds);

    const date = new Date(timestampInMs);
    const currentLocale = locale.value;
    const langPart = currentLocale.split('-')[0];
    const targetLocale = dateFnsLocales[currentLocale] || dateFnsLocales[langPart] || zhCN;

    return formatDistanceToNow(date, { addSuffix: true, locale: targetLocale });
  } catch {
    return String(timestampInSeconds);
  }
};

// 格式化审计动作文本
const getActionTranslation = (actionType: string): string => {
  const key = `auditLog.actions.${actionType}`;
  const translated = t(key);
  return translated === key ? actionType : translated;
};

const isFailedAction = (actionType: string): boolean => {
  const lower = actionType.toLowerCase();
  return lower.includes('fail') || lower.includes('error') || lower.includes('denied');
};

// 获取连接对应的标签名列表
const getConnTagNames = (tagIds?: number[]): string[] => {
  if (!tagIds || tagIds.length === 0) return [];
  return tagIds
    .map(id => tagMap.value.get(id))
    .filter((name): name is string => !!name);
};

// 刷新全量数据
const handleRefresh = async () => {
  if (isRefreshing.value) return;
  isRefreshing.value = true;
  try {
    await Promise.allSettled([
      connectionsStore.fetchConnections(),
      tagsStore.fetchTags(),
      auditLogStore.fetchLogs({
        page: 1,
        limit: 15,
        sortOrder: 'desc',
        isDashboardRequest: true,
      })
    ]);
    uiNotificationsStore.addNotification({
      type: 'success',
      message: '仪表盘数据已同步至最新'
    });
  } catch (err) {
    console.error('[MobileDashboard] 刷新数据失败:', err);
  } finally {
    setTimeout(() => {
      isRefreshing.value = false;
    }, 400);
  }
};

// 点击连接
const handleConnect = (conn: ConnectionInfo) => {
  sessionStore.handleConnectRequest(conn);
  router.push('/workspace');
};

// 快速跳转至工作区
const handleNavigateWorkspace = () => {
  router.push('/workspace');
};

// 复制主机地址
const handleCopyAddress = async (conn: ConnectionInfo, e?: Event) => {
  if (e) e.stopPropagation();
  const address = `${conn.username ? conn.username + '@' : ''}${conn.host}:${conn.port}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(address);
    } else {
      const input = document.createElement('input');
      input.value = address;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    copiedConnId.value = conn.id;
    uiNotificationsStore.addNotification({
      type: 'success',
      message: `已复制主机地址: ${address}`
    });
    setTimeout(() => {
      if (copiedConnId.value === conn.id) {
        copiedConnId.value = null;
      }
    }, 2000);
  } catch (err) {
    console.error('复制主机失败:', err);
  }
};

// 打开新建连接抽屉
const openAddConnection = () => {
  connToEdit.value = null;
  showAddEditModal.value = true;
};

// 打开编辑抽屉
const openEditConnection = (conn: ConnectionInfo) => {
  connToEdit.value = conn;
  showAddEditModal.value = true;
};

// 打开单卡片操作菜单
const openActionMenu = (conn: ConnectionInfo, e: Event) => {
  e.stopPropagation();
  selectedConnForAction.value = conn;
  showActionSheet.value = true;
};

const closeActionMenu = () => {
  showActionSheet.value = false;
  selectedConnForAction.value = null;
};

// 删除连接操作
const handleDeleteConnection = async (conn: ConnectionInfo) => {
  closeActionMenu();
  const confirmed = await showConfirmDialog({
    title: t('common.confirmationTitle', '确认删除'),
    message: `确定要删除连接「${conn.name || conn.host}」吗？此操作无法撤销。`,
    confirmText: t('common.delete', '删除'),
    cancelText: t('common.cancel', '取消'),
  });

  if (confirmed) {
    try {
      const success = await connectionsStore.deleteConnection(conn.id);
      if (success) {
        uiNotificationsStore.addNotification({
          type: 'success',
          message: `已成功删除连接「${conn.name || conn.host}」`
        });
      }
    } catch (err) {
      console.error('删除连接失败:', err);
    }
  }
};

// 添加/编辑成功回调
const handleFormSuccess = async () => {
  showAddEditModal.value = false;
  connToEdit.value = null;
  await connectionsStore.fetchConnections();
};

const handleFormClose = () => {
  showAddEditModal.value = false;
  connToEdit.value = null;
};

// 排序切换与设置
const setSortBy = (option: SortOption) => {
  if (sortBy.value === option) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortBy.value = option;
  }
};

const toggleSortOrder = () => {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
};

// 初始化加载
onMounted(async () => {
  if (connections.value.length === 0) {
    connectionsStore.fetchConnections().catch(console.error);
  }
  if (tags.value.length === 0) {
    tagsStore.fetchTags().catch(console.error);
  }
  auditLogStore.fetchLogs({
    page: 1,
    limit: 15,
    sortOrder: 'desc',
    isDashboardRequest: true,
  }).catch(console.error);
});
</script>

<template>
  <div class="mobile-dashboard w-full min-h-screen bg-background text-foreground flex flex-col pb-24 select-none">
    
    <!-- 1. 移动端顶部状态航标 -->
    <header class="sticky top-0 z-20 px-4 py-3 bg-header/90 backdrop-blur-md border-b border-border/70 flex items-center justify-between transition-colors">
      <div class="flex items-center space-x-2.5">
        <div class="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center text-primary shadow-sm">
          <i class="fas fa-gauge-high text-sm"></i>
        </div>
        <div>
          <h1 class="text-base font-bold tracking-tight text-foreground leading-tight flex items-center gap-1.5">
            {{ t('nav.dashboard', '星枢仪表盘') }}
            <span class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          </h1>
          <p class="text-[11px] text-muted-foreground leading-none mt-0.5">移动端特化控制台</p>
        </div>
      </div>

      <div class="flex items-center space-x-2">
        <!-- 手动刷新按钮 -->
        <button
          @click="handleRefresh"
          class="w-9 h-9 rounded-lg bg-card/80 border border-border/80 flex items-center justify-center text-muted-foreground hover:text-foreground active:scale-95 transition"
          :title="t('common.refresh', '刷新')"
        >
          <i :class="['fas fa-arrows-rotate text-sm', { 'animate-spin text-primary': isRefreshing }]"></i>
        </button>

        <!-- 快速添加按钮 -->
        <button
          @click="openAddConnection"
          class="px-3 py-1.5 h-9 rounded-lg bg-primary text-primary-foreground font-medium text-xs flex items-center gap-1.5 shadow-sm active:scale-95 transition"
        >
          <i class="fas fa-plus text-xs"></i>
          <span>新建连接</span>
        </button>
      </div>
    </header>

    <!-- 2. 主体内容容器 -->
    <main class="flex-1 px-3.5 pt-3 space-y-3.5 max-w-lg mx-auto w-full">

      <!-- A. 概览指标卡片组 (Hero Stats) -->
      <section class="grid grid-cols-3 gap-2">
        <!-- 统计 1: 连接数 -->
        <div 
          @click="activeTab = 'servers'; selectedTagId = null; searchQuery = ''"
          class="p-2.5 rounded-xl bg-card/75 border border-border/80 shadow-sm flex flex-col justify-between active:bg-muted/40 transition cursor-pointer"
        >
          <div class="flex items-center justify-between text-muted-foreground">
            <span class="text-[11px] font-medium">服务器</span>
            <i class="fas fa-server text-xs text-primary/80"></i>
          </div>
          <div class="mt-1 flex items-baseline justify-between">
            <span class="text-xl font-bold text-foreground font-mono">{{ connections.length }}</span>
            <span class="text-[10px] text-muted-foreground">台</span>
          </div>
        </div>

        <!-- 统计 2: 标签数 -->
        <div 
          @click="activeTab = 'servers'"
          class="p-2.5 rounded-xl bg-card/75 border border-border/80 shadow-sm flex flex-col justify-between active:bg-muted/40 transition cursor-pointer"
        >
          <div class="flex items-center justify-between text-muted-foreground">
            <span class="text-[11px] font-medium">标签分类</span>
            <i class="fas fa-tags text-xs text-amber-500/80"></i>
          </div>
          <div class="mt-1 flex items-baseline justify-between">
            <span class="text-xl font-bold text-foreground font-mono">{{ tags.length }}</span>
            <span class="text-[10px] text-muted-foreground">组</span>
          </div>
        </div>

        <!-- 统计 3: 最近审计 -->
        <div 
          @click="activeTab = 'activity'"
          class="p-2.5 rounded-xl bg-card/75 border border-border/80 shadow-sm flex flex-col justify-between active:bg-muted/40 transition cursor-pointer"
        >
          <div class="flex items-center justify-between text-muted-foreground">
            <span class="text-[11px] font-medium">审计动态</span>
            <i class="fas fa-clock-rotate-left text-xs text-blue-500/80"></i>
          </div>
          <div class="mt-1 flex items-baseline justify-between">
            <span class="text-xl font-bold text-foreground font-mono">{{ auditLogs.length }}</span>
            <span class="text-[10px] text-muted-foreground">条</span>
          </div>
        </div>
      </section>

      <!-- B. 快捷接入横幅 (直达工作区终端) -->
      <section 
        @click="handleNavigateWorkspace"
        class="p-3 rounded-xl bg-gradient-to-r from-primary/15 via-card to-card border border-primary/25 shadow-sm flex items-center justify-between active:scale-[0.99] transition cursor-pointer"
      >
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shadow">
            <i class="fas fa-terminal text-sm"></i>
          </div>
          <div>
            <div class="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <span>终端工作区 (Workspace)</span>
              <span class="px-1.5 py-0.2 text-[9px] bg-primary/20 text-primary font-mono rounded">直达</span>
            </div>
            <div class="text-[11px] text-muted-foreground mt-0.5">
              切换并管理当前活动的终端会话与连接
            </div>
          </div>
        </div>
        <i class="fas fa-chevron-right text-xs text-muted-foreground pr-1"></i>
      </section>

      <!-- C. 移动端分段控制器 (Segmented Switcher) -->
      <section class="bg-muted/50 p-1 rounded-xl border border-border/60 flex items-center">
        <button
          @click="activeTab = 'servers'"
          :class="[
            'flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5',
            activeTab === 'servers'
              ? 'bg-card text-foreground shadow-sm border border-border/40 font-bold'
              : 'text-muted-foreground hover:text-foreground'
          ]"
        >
          <i class="fas fa-server text-[11px]"></i>
          <span>服务器列表</span>
          <span 
            v-if="connections.length > 0" 
            :class="['px-1.5 py-0.2 text-[10px] rounded-full', activeTab === 'servers' ? 'bg-primary/20 text-primary font-mono' : 'bg-muted text-muted-foreground font-mono']"
          >
            {{ filteredAndSortedConnections.length }}
          </span>
        </button>

        <button
          @click="activeTab = 'activity'"
          :class="[
            'flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5',
            activeTab === 'activity'
              ? 'bg-card text-foreground shadow-sm border border-border/40 font-bold'
              : 'text-muted-foreground hover:text-foreground'
          ]"
        >
          <i class="fas fa-bolt text-[11px]"></i>
          <span>最近动态</span>
          <span 
            v-if="auditLogs.length > 0" 
            :class="['px-1.5 py-0.2 text-[10px] rounded-full', activeTab === 'activity' ? 'bg-primary/20 text-primary font-mono' : 'bg-muted text-muted-foreground font-mono']"
          >
            {{ auditLogs.length }}
          </span>
        </button>
      </section>

      <!-- D. 服务器列表视图 (Servers Tab) -->
      <div v-show="activeTab === 'servers'" class="space-y-3">
        <!-- 搜索栏 -->
        <div class="relative">
          <i class="fas fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索名称、IP、用户名、端口或标签..."
            class="w-full h-10 pl-9 pr-8 bg-card border border-border/80 rounded-xl text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition"
          />
          <button
            v-if="searchQuery"
            @click="searchQuery = ''"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 text-xs"
          >
            <i class="fas fa-circle-xmark"></i>
          </button>
        </div>

        <!-- 水平可滚动标签胶囊过滤栏 (Filter Chips) -->
        <div class="no-scrollbar flex items-center gap-1.5 overflow-x-auto py-0.5">
          <button
            v-for="item in allTagItems"
            :key="item.id === null ? 'all' : item.id"
            @click="selectedTagId = item.id"
            :class="[
              'px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all border flex items-center gap-1',
              selectedTagId === item.id
                ? 'bg-primary text-primary-foreground border-primary font-semibold shadow-sm'
                : 'bg-card/90 text-muted-foreground border-border hover:border-border/80 active:bg-muted'
            ]"
          >
            <i v-if="item.id !== null" class="fas fa-tag text-[9px] opacity-70"></i>
            <span>{{ item.name }}</span>
          </button>
        </div>

        <!-- 排序规则与结果条目计数 -->
        <div class="flex items-center justify-between text-xs text-muted-foreground px-0.5 pt-0.5">
          <span>共找到 <strong class="text-foreground font-mono">{{ filteredAndSortedConnections.length }}</strong> 个连接</span>

          <!-- 呼出排序选择器 -->
          <div class="flex items-center space-x-1.5">
            <button
              @click="showSortSheet = true"
              class="px-2 py-1 rounded-md bg-card border border-border text-[11px] text-foreground flex items-center gap-1 active:bg-muted transition"
            >
              <i class="fas fa-arrow-down-short-wide text-[10px] text-primary"></i>
              <span>{{ currentSortLabel }}</span>
            </button>
            <button
              @click="toggleSortOrder"
              class="w-6 h-6 rounded-md bg-card border border-border text-[11px] text-foreground flex items-center justify-center active:bg-muted transition"
              :title="sortOrder === 'asc' ? '升序' : '降序'"
            >
              <i :class="['fas', sortOrder === 'asc' ? 'fa-arrow-up' : 'fa-arrow-down', 'text-[10px]']"></i>
            </button>
          </div>
        </div>

        <!-- 加载中状态 -->
        <div v-if="isLoadingConnections && connections.length === 0" class="py-12 flex flex-col items-center justify-center text-muted-foreground space-y-2">
          <i class="fas fa-circle-notch fa-spin text-2xl text-primary"></i>
          <span class="text-xs">正在加载连接列表...</span>
        </div>

        <!-- 连接卡片流 -->
        <div v-else-if="filteredAndSortedConnections.length > 0" class="space-y-2.5">
          <div
            v-for="conn in filteredAndSortedConnections"
            :key="conn.id"
            class="server-touch-card p-3 rounded-xl bg-card border border-border/80 shadow-sm transition hover:border-primary/40 relative overflow-hidden"
          >
            <!-- 顶部行：图标、名称与操作按钮 -->
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center space-x-2.5 min-w-0 flex-1">
                <!-- 协议彩色徽标 -->
                <div 
                  :class="[
                    'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm border',
                    conn.type === 'VNC' 
                      ? 'bg-purple-500/15 border-purple-500/30 text-purple-400' 
                      : (conn.type === 'RDP' 
                        ? 'bg-amber-500/15 border-amber-500/30 text-amber-400' 
                        : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400')
                  ]"
                >
                  <i :class="['fas text-sm', conn.type === 'VNC' ? 'fa-plug' : (conn.type === 'RDP' ? 'fa-desktop' : 'fa-terminal')]"></i>
                </div>

                <!-- 名称与协议徽章 -->
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <h3 class="text-sm font-bold text-foreground truncate leading-tight">
                      {{ conn.name || conn.host || t('connections.unnamedFallback', '未命名连接') }}
                    </h3>
                    <span class="px-1.5 py-0.2 text-[9px] font-mono font-semibold rounded bg-muted text-muted-foreground uppercase flex-shrink-0">
                      {{ conn.type }}
                    </span>
                  </div>
                  
                  <!-- 地址与一键复制 -->
                  <div 
                    @click="handleCopyAddress(conn, $event)"
                    class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground active:text-primary transition cursor-pointer max-w-full"
                    title="点击复制主机连接串"
                  >
                    <span class="font-mono truncate select-all">
                      {{ conn.username ? conn.username + '@' : '' }}{{ conn.host }}:{{ conn.port }}
                    </span>
                    <i 
                      :class="[
                        'text-[10px] flex-shrink-0',
                        copiedConnId === conn.id ? 'fas fa-check text-emerald-500' : 'far fa-copy opacity-60'
                      ]"
                    ></i>
                  </div>
                </div>
              </div>

              <!-- 右侧菜单按钮 -->
              <button
                @click="openActionMenu(conn, $event)"
                class="w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground active:bg-muted flex items-center justify-center transition flex-shrink-0"
                title="更多操作"
              >
                <i class="fas fa-ellipsis-vertical text-xs"></i>
              </button>
            </div>

            <!-- 中间行：标签与上次连接时间 -->
            <div class="mt-2.5 pt-2 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground">
              <!-- 标签胶囊 -->
              <div class="flex flex-wrap gap-1 min-w-0 flex-1 mr-2">
                <template v-if="getConnTagNames(conn.tag_ids).length > 0">
                  <span
                    v-for="tagName in getConnTagNames(conn.tag_ids)"
                    :key="tagName"
                    class="px-1.5 py-0.2 rounded bg-muted/80 text-muted-foreground border border-border/50 text-[10px] truncate max-w-[100px]"
                  >
                    {{ tagName }}
                  </span>
                </template>
                <span v-else class="text-[10px] text-muted-foreground/50">无标签</span>
              </div>

              <!-- 上次连接 -->
              <div class="flex items-center gap-1 flex-shrink-0 text-[10px]">
                <i class="far fa-clock opacity-60"></i>
                <span>{{ formatRelativeTime(conn.last_connected_at) }}</span>
              </div>
            </div>

            <!-- 底部行：直连大按钮 -->
            <div class="mt-2.5">
              <button
                @click="handleConnect(conn)"
                class="w-full py-2 px-3 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary border border-primary/25 font-semibold text-xs flex items-center justify-center gap-1.5 active:scale-[0.98] transition shadow-xs"
              >
                <i class="fas fa-bolt text-xs"></i>
                <span>立即连接</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-else class="py-12 px-4 text-center rounded-xl bg-card/50 border border-dashed border-border flex flex-col items-center justify-center space-y-3">
          <div class="w-12 h-12 rounded-full bg-muted/70 flex items-center justify-center text-muted-foreground text-xl">
            <i class="fas fa-network-wired"></i>
          </div>
          <div>
            <p class="text-sm font-medium text-foreground">没有找到匹配的服务器连接</p>
            <p class="text-xs text-muted-foreground mt-1">您可以尝试清空筛选条件，或直接添加新的服务器</p>
          </div>
          <div class="flex items-center gap-2 pt-1">
            <button
              v-if="searchQuery || selectedTagId !== null"
              @click="searchQuery = ''; selectedTagId = null"
              class="px-3 py-1.5 rounded-lg bg-card border border-border text-xs text-foreground font-medium active:bg-muted transition"
            >
              清空筛选
            </button>
            <button
              @click="openAddConnection"
              class="px-3.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold shadow-sm active:scale-95 transition"
            >
              新建连接
            </button>
          </div>
        </div>
      </div>

      <!-- E. 最近动态视图 (Activity Tab) -->
      <div v-show="activeTab === 'activity'" class="space-y-3">
        <div class="flex items-center justify-between text-xs text-muted-foreground px-0.5">
          <span>最近记录 ({{ recentAuditLogs.length }})</span>
          <RouterLink :to="{ name: 'AuditLogs' }" class="text-primary hover:underline flex items-center gap-1">
            <span>完整审计日志</span>
            <i class="fas fa-arrow-up-right-from-square text-[10px]"></i>
          </RouterLink>
        </div>

        <!-- 加载中 -->
        <div v-if="isLoadingLogs && recentAuditLogs.length === 0" class="py-12 flex flex-col items-center justify-center text-muted-foreground space-y-2">
          <i class="fas fa-circle-notch fa-spin text-2xl text-primary"></i>
          <span class="text-xs">加载审计动态中...</span>
        </div>

        <!-- 动态日志流 -->
        <div v-else-if="recentAuditLogs.length > 0" class="space-y-2">
          <div
            v-for="log in recentAuditLogs"
            :key="log.id"
            class="p-3 rounded-xl bg-card border border-border/80 shadow-sm space-y-1.5"
          >
            <div class="flex items-start justify-between gap-2">
              <span
                :class="[
                  'px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 border',
                  isFailedAction(log.action_type)
                    ? 'bg-red-500/15 text-red-400 border-red-500/30'
                    : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                ]"
              >
                <i :class="['fas text-[9px]', isFailedAction(log.action_type) ? 'fa-triangle-exclamation' : 'fa-check']"></i>
                <span>{{ getActionTranslation(log.action_type) }}</span>
              </span>

              <span class="text-[10px] text-muted-foreground flex-shrink-0 font-mono">
                {{ formatRelativeTime(log.timestamp) }}
              </span>
            </div>

            <p class="text-xs text-foreground/90 break-words leading-relaxed pt-0.5">
              {{ log.details }}
            </p>
          </div>

          <!-- 查看更多卡片 -->
          <div class="pt-2">
            <RouterLink 
              :to="{ name: 'AuditLogs' }"
              class="w-full py-2.5 px-3 rounded-xl bg-card border border-border/80 text-foreground font-medium text-xs flex items-center justify-center gap-1.5 active:bg-muted transition"
            >
              <span>查看全部审计日志</span>
              <i class="fas fa-arrow-right text-[10px] text-muted-foreground"></i>
            </RouterLink>
          </div>
        </div>

        <!-- 空动态 -->
        <div v-else class="py-12 px-4 text-center rounded-xl bg-card/50 border border-dashed border-border flex flex-col items-center justify-center space-y-2">
          <i class="fas fa-shield-halved text-2xl text-muted-foreground/60"></i>
          <p class="text-xs text-muted-foreground">暂无最近活动记录</p>
        </div>
      </div>

    </main>

    <!-- 3. 移动端排序选择抽屉 (Sort Sheet) -->
    <Teleport to="body">
      <Transition name="fade">
        <div 
          v-if="showSortSheet" 
          @click="showSortSheet = false" 
          class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-opacity"
        ></div>
      </Transition>

      <Transition name="bottom-sheet">
        <div
          v-if="showSortSheet"
          class="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border rounded-t-2xl max-w-lg mx-auto shadow-2xl p-4 space-y-4"
          style="padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0px));"
        >
          <!-- 顶部手柄 -->
          <div class="flex justify-center -mt-1">
            <div class="w-10 h-1 bg-muted-foreground/30 rounded-full"></div>
          </div>

          <div class="flex items-center justify-between pb-2 border-b border-border/60">
            <h3 class="text-sm font-bold text-foreground">排序方式</h3>
            <button @click="showSortSheet = false" class="text-xs text-muted-foreground hover:text-foreground">完成</button>
          </div>

          <!-- 排序字段列表 -->
          <div class="space-y-1.5">
            <button
              v-for="item in sortConfig"
              :key="item.value"
              @click="setSortBy(item.value)"
              :class="[
                'w-full p-2.5 rounded-xl text-xs flex items-center justify-between border transition',
                sortBy === item.value
                  ? 'bg-primary/10 border-primary text-primary font-bold'
                  : 'bg-card border-border/50 text-foreground active:bg-muted'
              ]"
            >
              <div class="flex items-center space-x-2.5">
                <i :class="['fas', item.icon, 'text-xs opacity-75']"></i>
                <span>{{ item.label }}</span>
              </div>
              <i v-if="sortBy === item.value" class="fas fa-check text-xs text-primary"></i>
            </button>
          </div>

          <!-- 升降序切换 -->
          <div class="pt-2 border-t border-border/60 flex items-center justify-between">
            <span class="text-xs text-muted-foreground">排序方向</span>
            <div class="flex rounded-lg bg-muted p-0.5 border border-border/60">
              <button
                @click="sortOrder = 'desc'"
                :class="['px-3 py-1 rounded text-xs font-medium transition', sortOrder === 'desc' ? 'bg-card text-foreground shadow-xs font-bold' : 'text-muted-foreground']"
              >
                降序 (从新到旧)
              </button>
              <button
                @click="sortOrder = 'asc'"
                :class="['px-3 py-1 rounded text-xs font-medium transition', sortOrder === 'asc' ? 'bg-card text-foreground shadow-xs font-bold' : 'text-muted-foreground']"
              >
                升序 (从旧到新)
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 4. 服务器卡片 ActionSheet 操作抽屉 -->
    <Teleport to="body">
      <Transition name="fade">
        <div 
          v-if="showActionSheet" 
          @click="closeActionMenu" 
          class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-opacity"
        ></div>
      </Transition>

      <Transition name="bottom-sheet">
        <div
          v-if="showActionSheet && selectedConnForAction"
          class="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border rounded-t-2xl max-w-lg mx-auto shadow-2xl p-4 space-y-3"
          style="padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0px));"
        >
          <!-- 顶部手柄 -->
          <div class="flex justify-center -mt-1">
            <div class="w-10 h-1 bg-muted-foreground/30 rounded-full"></div>
          </div>

          <!-- 卡片摘要 -->
          <div class="pb-2 border-b border-border/60">
            <div class="text-sm font-bold text-foreground truncate">
              {{ selectedConnForAction.name || selectedConnForAction.host }}
            </div>
            <div class="text-xs text-muted-foreground font-mono mt-0.5 truncate">
              {{ selectedConnForAction.username }}@{{ selectedConnForAction.host }}:{{ selectedConnForAction.port }}
            </div>
          </div>

          <!-- 操作列表 -->
          <div class="space-y-1.5">
            <!-- 立即连接 -->
            <button
              @click="closeActionMenu(); handleConnect(selectedConnForAction)"
              class="w-full p-3 rounded-xl bg-primary text-primary-foreground font-bold text-xs flex items-center justify-center gap-2 active:scale-[0.99] transition shadow-sm"
            >
              <i class="fas fa-bolt"></i>
              <span>立即连接终端</span>
            </button>

            <!-- 编辑 -->
            <button
              @click="closeActionMenu(); openEditConnection(selectedConnForAction)"
              class="w-full p-2.5 rounded-xl bg-card border border-border text-foreground font-medium text-xs flex items-center justify-center gap-2 active:bg-muted transition"
            >
              <i class="fas fa-pencil text-muted-foreground"></i>
              <span>编辑连接配置</span>
            </button>

            <!-- 复制地址 -->
            <button
              @click="handleCopyAddress(selectedConnForAction); closeActionMenu()"
              class="w-full p-2.5 rounded-xl bg-card border border-border text-foreground font-medium text-xs flex items-center justify-center gap-2 active:bg-muted transition"
            >
              <i class="far fa-copy text-muted-foreground"></i>
              <span>复制主机地址</span>
            </button>

            <!-- 删除 -->
            <button
              @click="handleDeleteConnection(selectedConnForAction)"
              class="w-full p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 font-medium text-xs flex items-center justify-center gap-2 active:bg-red-500/20 transition"
            >
              <i class="fas fa-trash-can"></i>
              <span>删除连接</span>
            </button>
          </div>

          <!-- 取消按钮 -->
          <button
            @click="closeActionMenu"
            class="w-full py-2.5 rounded-xl bg-muted text-muted-foreground text-xs font-semibold active:bg-muted/80 transition"
          >
            取消
          </button>
        </div>
      </Transition>
    </Teleport>

    <!-- 5. 添加/编辑连接抽屉 (AddConnectionForm 内部已具备移动端抽屉能力) -->
    <AddConnectionForm
      v-if="showAddEditModal"
      :connection-to-edit="connToEdit"
      :is-mobile="true"
      @close="handleFormClose"
      @connection-added="handleFormSuccess"
      @connection-updated="handleFormSuccess"
    />

  </div>
</template>

<style scoped>
/* 隐藏水平滚动条 */
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* 底部抽屉过渡动画 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  transform: translateY(100%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
