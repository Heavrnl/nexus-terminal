<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../stores/session.store';
import { storeToRefs } from 'pinia';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';

const { t } = useI18n();
const sessionStore = useSessionStore();
const { activeSession } = storeToRefs(sessionStore); // Get reactive active session
const emitWorkspaceEvent = useWorkspaceEventEmitter();

// --- 搜索与状态过滤 ---
const searchQuery = ref('');
const statusFilter = ref<'all' | 'running' | 'exited'>('all');

// --- Get Docker Manager Instance from Active Session ---
const dockerManager = computed(() => activeSession.value?.dockerManager);

// --- Computed properties based on Docker Manager state ---
const containers = computed(() => dockerManager.value?.containers.value ?? []);
const isLoading = computed(() => dockerManager.value?.isLoading.value ?? false);
const error = computed(() => dockerManager.value?.error.value ?? null);
const isDockerAvailable = computed(() => dockerManager.value?.isDockerAvailable.value ?? false);
const expandedContainerIds = computed(() => dockerManager.value?.expandedContainerIds.value ?? new Set<string>());

// 状态计数
const runningCount = computed(() => containers.value.filter(c => c.State === 'running').length);
const stoppedCount = computed(() => containers.value.filter(c => c.State !== 'running').length);

// --- Computed properties for UI state (independent of dockerManager) ---
const currentSessionId = computed(() => activeSession.value?.sessionId);
const sshConnectionStatus = computed(() => activeSession.value?.wsManager.connectionStatus.value ?? 'disconnected');

// --- 格式化容器名称 ---
const formatContainerName = (names?: readonly string[] | string[]) => {
  if (!names || names.length === 0) return 'N/A';
  return names.map(n => (n.startsWith('/') ? n.slice(1) : n)).join(', ');
};

// --- 即时搜索与状态过滤容器列表 ---
const filteredContainers = computed(() => {
  let list = containers.value;

  // 状态过滤
  if (statusFilter.value === 'running') {
    list = list.filter(c => c.State === 'running');
  } else if (statusFilter.value === 'exited') {
    list = list.filter(c => c.State !== 'running');
  }

  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return list;

  return list.filter(container => {
    // 匹配容器名（包含去掉前缀斜杠与原生名字）
    const matchName = container.Names?.some(name => {
      const lower = name.toLowerCase();
      const clean = lower.startsWith('/') ? lower.slice(1) : lower;
      return clean.includes(query) || lower.includes(query);
    });
    // 匹配镜像名
    const matchImage = container.Image?.toLowerCase().includes(query);
    // 匹配容器 ID (短 ID 或全 ID)
    const matchId = container.id?.toLowerCase().includes(query);
    return Boolean(matchName || matchImage || matchId);
  });
});

// 清空搜索内容
const clearSearch = () => {
  searchQuery.value = '';
};

// 手动刷新容器列表
const refreshContainers = () => {
  dockerManager.value?.requestDockerStatus();
};

// --- Methods delegated to Docker Manager ---
const sendDockerCommand = (containerId: string, command: 'start' | 'stop' | 'restart' | 'remove') => {
  dockerManager.value?.sendDockerCommand(containerId, command);
};

const toggleExpand = (containerId: string) => {
  dockerManager.value?.toggleExpand(containerId);
};

const enterContainer = (containerId: string) => {
  if (activeSession.value?.sessionId) {
    const command = `docker exec -it ${containerId} sh\n`;
    emitWorkspaceEvent('terminal:sendCommand', { command, sessionId: activeSession.value.sessionId });
  }
};

const viewContainerLogs = (containerId: string) => {
  if (activeSession.value?.sessionId) {
    const command = `docker logs --tail 1000 -f ${containerId}\n`;
    emitWorkspaceEvent('terminal:sendCommand', { command, sessionId: activeSession.value.sessionId });
  }
};
</script>

<template>
  <div class="docker-manager flex flex-col h-full overflow-hidden bg-background text-foreground">
    <!-- Case 1: No active session -->
    <div v-if="!currentSessionId" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary p-4">
      <i class="fas fa-plug text-4xl mb-3"></i>
      <p class="mt-2 mb-1 font-medium">{{ t('dockerManager.error.noActiveSession') }}</p>
      <small class="text-xs max-w-[80%] text-text-disabled">{{ t('dockerManager.error.connectFirst') }}</small>
    </div>
    <!-- Case 2: Active session, SSH connecting -->
    <div v-else-if="sshConnectionStatus === 'connecting'" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary p-4">
      <i class="fas fa-spinner fa-spin text-4xl mb-3"></i>
      <p class="mt-2 mb-1 font-medium">{{ t('dockerManager.waitingForSsh') }}</p>
      <small class="text-xs max-w-[80%] text-text-disabled">{{ activeSession?.wsManager.statusMessage.value || '...' }}</small>
    </div>
    <!-- Case 3: Active session, SSH disconnected -->
    <div v-else-if="sshConnectionStatus === 'disconnected'" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary p-4">
      <i class="fas fa-unlink text-4xl mb-3"></i>
      <p class="mt-2 mb-1 font-medium">{{ t('dockerManager.error.sshDisconnected') }}</p>
      <small class="text-xs max-w-[80%] text-text-disabled">{{ activeSession?.wsManager.statusMessage.value || '...' }}</small>
    </div>
    <!-- Case 4: Active session, SSH error -->
    <div v-else-if="sshConnectionStatus === 'error'" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary p-4">
      <i class="fas fa-exclamation-circle text-3xl text-red-500 mb-2"></i>
      <p class="mt-2 mb-1 font-medium">{{ t('dockerManager.error.sshError') }}</p>
      <small class="text-xs max-w-[80%]">{{ activeSession?.wsManager.statusMessage.value || 'Unknown SSH error' }}</small>
    </div>
    <!-- Case 5: Active session, SSH connected, Docker loading -->
    <div v-else-if="isLoading && containers.length === 0" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary p-4">
      <i class="fas fa-spinner fa-spin text-4xl mb-3"></i> {{ t('dockerManager.loading') }}
    </div>
    <!-- Case 6: Active session, SSH connected, Docker unavailable -->
    <div v-else-if="!isDockerAvailable" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary p-4">
      <i class="fab fa-docker text-4xl mb-3"></i>
      <p class="mt-2 mb-1 font-medium">{{ t('dockerManager.notAvailable') }}</p>
      <small class="text-xs max-w-[80%] text-text-disabled">{{ t('dockerManager.installHintRemote') }}</small>
    </div>
    <!-- Case 7: Active session, SSH connected, Fetch error -->
    <div v-else-if="error" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary p-4">
      <i class="fas fa-exclamation-triangle text-3xl text-red-500 mb-2"></i>
      <p class="mt-2 mb-1 font-medium">{{ t('dockerManager.error.fetchFailed') }}</p>
      <small class="text-xs max-w-[80%]">{{ error }}</small>
    </div>
    <!-- Case 8: Active session, SSH connected, Docker available, show toolbar and list -->
    <div v-else class="flex flex-col h-full overflow-hidden">
      <!-- 顶部操作栏 / 搜索栏与状态过滤组 -->
      <div class="docker-toolbar flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-border/40 bg-header/20 shrink-0">
        <!-- 左侧：搜索输入框与状态快速筛选药丸组 -->
        <div class="flex items-center gap-3 flex-1 min-w-0 flex-wrap">
          <!-- 搜索输入框 -->
          <div class="relative w-full max-w-xs sm:max-w-sm">
            <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-secondary/60 pointer-events-none"></i>
            <input
              type="text"
              v-model="searchQuery"
              :placeholder="t('dockerManager.searchPlaceholder', '搜索容器名称、镜像或 ID...')"
              class="w-full h-8.5 pl-9 pr-8 text-xs sm:text-sm bg-background border border-border/70 rounded-lg text-foreground placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all shadow-2xs"
              @keydown.esc="clearSearch"
            />
            <!-- 一键清空按钮 -->
            <button
              v-if="searchQuery"
              type="button"
              @click="clearSearch"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-sm p-0.5 rounded cursor-pointer transition-colors"
              :title="t('dockerManager.clearSearch', '清空搜索')"
            >
              <i class="fas fa-times-circle"></i>
            </button>
          </div>

          <!-- 状态快速筛选药丸组 -->
          <div class="flex items-center gap-1.5 text-xs select-none shrink-0">
            <button
              type="button"
              @click="statusFilter = 'all'"
              class="h-8.5 px-3 rounded-lg font-medium transition-all cursor-pointer flex items-center"
              :class="statusFilter === 'all' ? 'bg-primary text-primary-foreground shadow-2xs' : 'bg-background border border-border/60 text-text-secondary hover:text-foreground hover:bg-header/40'"
            >
              全部 ({{ containers.length }})
            </button>
            <button
              type="button"
              @click="statusFilter = 'running'"
              class="h-8.5 px-3 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer"
              :class="statusFilter === 'running' ? 'bg-emerald-500 text-white shadow-2xs' : 'bg-background border border-border/60 text-text-secondary hover:text-foreground hover:bg-header/40'"
            >
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>运行中 ({{ runningCount }})</span>
            </button>
            <button
              type="button"
              @click="statusFilter = 'exited'"
              class="h-8.5 px-3 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer"
              :class="statusFilter === 'exited' ? 'bg-rose-500 text-white shadow-2xs' : 'bg-background border border-border/60 text-text-secondary hover:text-foreground hover:bg-header/40'"
            >
              <span class="w-2 h-2 rounded-full bg-rose-400"></span>
              <span>已停止 ({{ stoppedCount }})</span>
            </button>
          </div>
        </div>

        <!-- 数量统计与刷新按钮 -->
        <div class="flex items-center gap-3 shrink-0 text-sm text-text-secondary">
          <span v-if="containers.length > 0" class="text-xs font-medium select-none hidden lg:inline-block">
            <template v-if="searchQuery.trim() || statusFilter !== 'all'">
              {{ t('dockerManager.filteredCount', { filtered: filteredContainers.length, total: containers.length }) }}
            </template>
            <template v-else>
              {{ t('dockerManager.containerCount', { count: containers.length }) }}
            </template>
          </span>
          <button
            @click="refreshContainers"
            :disabled="isLoading"
            class="h-8.5 w-8.5 flex items-center justify-center text-sm text-text-secondary hover:text-foreground hover:bg-header/60 rounded-lg border border-border/50 transition-colors cursor-pointer disabled:opacity-50 shadow-2xs"
            :title="t('common.refresh', '刷新')"
          >
            <i :class="['fas fa-sync-alt', isLoading ? 'fa-spin text-primary' : '']"></i>
          </button>
        </div>
      </div>

      <!-- 容器内容滚动区域 (去除单元格密集横线，回归现代通透感) -->
      <div class="docker-content-area flex-grow overflow-auto">
        <!-- 暂无容器 -->
        <div v-if="containers.length === 0 && !isLoading" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary h-full p-8">
          <i class="fab fa-docker text-4xl mb-3 opacity-30"></i>
          <p class="font-medium text-base text-foreground">{{ t('dockerManager.noContainers') }}</p>
        </div>

        <!-- 搜索或筛选无结果 -->
        <div v-else-if="filteredContainers.length === 0" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary h-full p-8">
          <i class="fas fa-filter text-3xl mb-3 opacity-30"></i>
          <p class="text-base font-medium text-foreground mb-1">
            {{ searchQuery.trim() ? t('dockerManager.noMatchingContainers', '未找到匹配的容器') : '未找到符合筛选条件的容器' }}
          </p>
          <p v-if="searchQuery.trim()" class="text-sm text-text-secondary mb-4">
            {{ t('dockerManager.noMatchingHint', { query: searchQuery }) }}
          </p>
          <div class="flex items-center gap-2 mt-2">
            <button
              v-if="searchQuery"
              @click="clearSearch"
              class="px-3.5 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-header/60 text-foreground transition-colors cursor-pointer"
            >
              {{ t('dockerManager.clearSearch', '清空搜索') }}
            </button>
            <button
              v-if="statusFilter !== 'all'"
              @click="statusFilter = 'all'"
              class="px-3.5 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-header/60 text-foreground transition-colors cursor-pointer"
            >
              显示全部容器
            </button>
          </div>
        </div>

        <!-- 容器表格 (仅在 tr 级别保留极浅的底部分割线，去除所有 td 的内部实线) -->
        <table v-else class="w-full border-collapse text-sm">
          <thead class="responsive-thead">
            <tr class="bg-header/40 text-text-secondary text-xs uppercase tracking-wider border-b border-border/40">
              <th class="w-10 px-3 py-2.5 text-center font-medium"></th>
              <th class="px-4 py-2.5 text-left font-medium">{{ t('dockerManager.header.name') }}</th>
              <th class="px-4 py-2.5 text-left font-medium">{{ t('dockerManager.header.image') }}</th>
              <th class="px-4 py-2.5 text-left font-medium">{{ t('dockerManager.header.status') }}</th>
              <th class="px-4 py-2.5 text-left font-medium">{{ t('dockerManager.header.ports') }}</th>
              <th class="px-4 py-2.5 text-right font-medium">{{ t('dockerManager.header.actions') }}</th>
            </tr>
          </thead>
          <tbody class="responsive-tbody">
            <template v-for="container in filteredContainers" :key="container.id">
              <!-- 行容器：只有平滑的底部轻度微分割线与 hover 质感 -->
              <tr class="responsive-tr border-b border-border/25 hover:bg-header/20 transition-colors duration-150"
                  :class="{'expanded': expandedContainerIds.has(container.id)}">
                <!-- 展开折叠按钮 -->
                <td class="responsive-td-expand w-10 px-3 py-3 text-center align-middle">
                  <button @click="toggleExpand(container.id)" class="text-text-secondary hover:text-foreground transition-colors p-1 text-xs" :title="expandedContainerIds.has(container.id) ? t('common.collapse') : t('common.expand')">
                    <i :class="['fas', expandedContainerIds.has(container.id) ? 'fa-chevron-down' : 'fa-chevron-right']"></i>
                  </button>
                </td>
                <!-- 容器名称 -->
                <td class="responsive-td px-4 py-3 align-middle" :data-label="t('dockerManager.header.name')">
                  <span class="font-medium text-foreground text-sm">{{ formatContainerName(container.Names) }}</span>
                </td>
                <!-- 镜像 -->
                <td class="responsive-td px-4 py-3 align-middle break-all text-text-secondary text-xs font-mono" :data-label="t('dockerManager.header.image')">
                  {{ container.Image }}
                </td>
                <!-- 状态徽章 -->
                <td class="responsive-td px-4 py-3 align-middle" :data-label="t('dockerManager.header.status')">
                  <span :class="['px-2.5 py-0.5 rounded-full text-xs font-medium text-white whitespace-nowrap shadow-2xs',
                                 container.State === 'running' ? 'bg-emerald-500' :
                                 container.State === 'exited' ? 'bg-rose-500' :
                                 container.State === 'paused' ? 'bg-amber-500 text-gray-900' :
                                 container.State === 'restarting' ? 'bg-sky-500' :
                                 'bg-neutral-500']">
                    {{ container.Status }}
                  </span>
                </td>
                <!-- 端口映射 -->
                <td class="responsive-td px-4 py-3 align-middle break-all text-xs font-mono text-text-secondary" :data-label="t('dockerManager.header.ports')">
                  {{ container.Ports?.map(p => `${p.IP ? p.IP + ':' : ''}${p.PublicPort ? p.PublicPort + '->' : ''}${p.PrivatePort}/${p.Type}`).join(', ') || 'N/A' }}
                </td>
                <!-- 操作栏 -->
                <td class="responsive-td px-4 py-3 align-middle text-right" :data-label="t('dockerManager.header.actions')">
                  <div class="responsive-actions-container flex justify-end items-center gap-2.5 flex-wrap">
                    <button @click="sendDockerCommand(container.id, 'start')" :title="t('dockerManager.action.start')" class="text-text-secondary hover:text-emerald-500 disabled:opacity-20 disabled:cursor-not-allowed transition-colors p-1 text-sm cursor-pointer" :disabled="container.State === 'running'">
                      <i class="fas fa-play"></i>
                    </button>
                    <button @click="sendDockerCommand(container.id, 'stop')" :title="t('dockerManager.action.stop')" class="text-text-secondary hover:text-amber-500 disabled:opacity-20 disabled:cursor-not-allowed transition-colors p-1 text-sm cursor-pointer" :disabled="container.State !== 'running'">
                      <i class="fas fa-stop"></i>
                    </button>
                    <button @click="sendDockerCommand(container.id, 'restart')" :title="t('dockerManager.action.restart')" class="text-text-secondary hover:text-sky-500 disabled:opacity-20 disabled:cursor-not-allowed transition-colors p-1 text-sm cursor-pointer" :disabled="container.State !== 'running'">
                      <i class="fas fa-sync-alt"></i>
                    </button>
                    <button @click="sendDockerCommand(container.id, 'remove')" :title="t('dockerManager.action.remove')" class="text-text-secondary hover:text-rose-500 disabled:opacity-20 disabled:cursor-not-allowed transition-colors p-1 text-sm cursor-pointer">
                      <i class="fas fa-trash-alt"></i>
                    </button>
                    <button @click="enterContainer(container.id)" :title="t('dockerManager.action.enter')" class="text-text-secondary hover:text-indigo-400 transition-colors p-1 text-sm cursor-pointer">
                      <i class="fas fa-terminal"></i>
                    </button>
                    <button @click="viewContainerLogs(container.id)" :title="t('dockerManager.action.logs')" class="text-text-secondary hover:text-foreground transition-colors p-1 text-sm cursor-pointer">
                      <i class="fas fa-file-alt"></i>
                    </button>
                  </div>
                </td>

                <!-- 窄屏折叠展开按钮区 -->
                <td class="responsive-td-card-expand w-full p-0 mt-2">
                  <div v-if="!expandedContainerIds.has(container.id)">
                    <button @click="toggleExpand(container.id)" class="flex items-center justify-center w-full h-8 text-text-secondary hover:text-foreground hover:bg-header/30 transition-colors text-xs rounded-b cursor-pointer">
                      <i class="fas fa-chevron-down mr-1"></i> {{ t('common.expand') }}
                    </button>
                  </div>
                  <div v-if="expandedContainerIds.has(container.id)" class="bg-header/20 rounded-b mt-2">
                    <div class="p-3">
                      <dl v-if="container.stats" class="grid grid-cols-[max-content_auto] gap-x-4 gap-y-1.5 text-xs">
                        <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.cpu') }}</dt>
                        <dd class="font-mono text-foreground">{{ container.stats.CPUPerc ?? 'N/A' }}</dd>
                        <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.memory') }}</dt>
                        <dd class="font-mono text-foreground">{{ container.stats.MemUsage ?? 'N/A' }} ({{ container.stats.MemPerc ?? 'N/A' }})</dd>
                        <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.netIO') }}</dt>
                        <dd class="font-mono text-foreground">{{ container.stats.NetIO ?? 'N/A' }}</dd>
                        <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.blockIO') }}</dt>
                        <dd class="font-mono text-foreground">{{ container.stats.BlockIO ?? 'N/A' }}</dd>
                        <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.pids') }}</dt>
                        <dd class="font-mono text-foreground">{{ container.stats.PIDs ?? 'N/A' }}</dd>
                      </dl>
                      <div v-else class="text-center text-text-secondary italic text-xs py-1.5">
                        {{ t('dockerManager.stats.noData') }}
                      </div>
                    </div>
                    <button @click="toggleExpand(container.id)" class="flex items-center justify-center w-full h-8 text-text-secondary hover:text-foreground hover:bg-header/30 transition-colors text-xs rounded-b cursor-pointer">
                      <i class="fas fa-chevron-up mr-1"></i> {{ t('common.collapse') }}
                    </button>
                  </div>
                </td>
              </tr>

              <!-- 桌面端详情展开行 (去除生硬线条，使用柔和内凹背景) -->
              <tr v-if="expandedContainerIds.has(container.id)" class="responsive-expansion-row bg-muted/15 border-b border-border/20">
                <td :colspan="6" class="p-0">
                  <div class="px-6 py-4">
                    <dl v-if="container.stats" class="grid grid-cols-2 md:grid-cols-5 gap-4 text-xs">
                      <div class="bg-background/60 p-2.5 rounded-lg border border-border/40">
                        <dt class="text-text-secondary mb-1">{{ t('dockerManager.stats.cpu') }}</dt>
                        <dd class="font-mono font-semibold text-sm text-foreground">{{ container.stats.CPUPerc ?? 'N/A' }}</dd>
                      </div>
                      <div class="bg-background/60 p-2.5 rounded-lg border border-border/40">
                        <dt class="text-text-secondary mb-1">{{ t('dockerManager.stats.memory') }}</dt>
                        <dd class="font-mono font-semibold text-sm text-foreground">{{ container.stats.MemUsage ?? 'N/A' }}</dd>
                        <span class="text-[11px] text-text-secondary font-mono">({{ container.stats.MemPerc ?? 'N/A' }})</span>
                      </div>
                      <div class="bg-background/60 p-2.5 rounded-lg border border-border/40">
                        <dt class="text-text-secondary mb-1">{{ t('dockerManager.stats.netIO') }}</dt>
                        <dd class="font-mono font-semibold text-sm text-foreground">{{ container.stats.NetIO ?? 'N/A' }}</dd>
                      </div>
                      <div class="bg-background/60 p-2.5 rounded-lg border border-border/40">
                        <dt class="text-text-secondary mb-1">{{ t('dockerManager.stats.blockIO') }}</dt>
                        <dd class="font-mono font-semibold text-sm text-foreground">{{ container.stats.BlockIO ?? 'N/A' }}</dd>
                      </div>
                      <div class="bg-background/60 p-2.5 rounded-lg border border-border/40">
                        <dt class="text-text-secondary mb-1">{{ t('dockerManager.stats.pids') }}</dt>
                        <dd class="font-mono font-semibold text-sm text-foreground">{{ container.stats.PIDs ?? 'N/A' }}</dd>
                      </div>
                    </dl>
                    <div v-else class="text-center text-text-secondary italic text-xs py-2">
                      {{ t('dockerManager.stats.noData') }}
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.docker-manager {
  container-type: inline-size;
  container-name: docker-manager-pane;
}

/* Default styles (Table view) */
.responsive-thead { display: table-header-group; }
.responsive-tbody { display: table-row-group; }
.responsive-tr { display: table-row; }
.responsive-td { display: table-cell; vertical-align: middle; }
.responsive-td-expand { display: table-cell; vertical-align: middle; }
.responsive-td-card-expand { display: none; }
.responsive-expansion-row { display: table-row; }
.responsive-actions-container { justify-content: flex-end; }

/* 窄屏卡片视图：去除多余横线，采用卡片式轻量整洁结构 */
@container docker-manager-pane (max-width: 600px) {
  .docker-content-area {
    padding: 0.75rem;
  }

  .responsive-thead.responsive-thead {
    display: none;
  }

  .responsive-tbody.responsive-tbody {
    display: block;
  }

  .responsive-tr.responsive-tr {
    display: block;
    margin-bottom: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    padding: 0.75rem;
    background-color: var(--app-bg-color);
  }

  /* 彻底移除 td 内部横线，改用自然的行距 */
  .responsive-td.responsive-td {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: none !important;
    padding: 0.35rem 0;
    text-align: right;
  }

  .responsive-td.responsive-td::before {
    content: attr(data-label);
    font-weight: 500;
    font-size: 0.75rem;
    text-align: left;
    color: var(--text-color-secondary);
    padding-right: 0.5rem;
    flex-shrink: 0;
  }

  .responsive-td-expand.responsive-td-expand {
    display: none;
  }

  .responsive-td-card-expand.responsive-td-card-expand {
    display: block;
  }

  .responsive-expansion-row.responsive-expansion-row {
    display: none;
  }

  .responsive-actions-container.responsive-actions-container {
    justify-content: flex-end;
    width: 100%;
    padding-top: 0.25rem;
  }
}
</style>
