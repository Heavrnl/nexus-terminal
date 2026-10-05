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

// --- 搜索状态 ---
const searchQuery = ref('');

// --- Get Docker Manager Instance from Active Session ---
const dockerManager = computed(() => activeSession.value?.dockerManager);

// --- Computed properties based on Docker Manager state ---
const containers = computed(() => dockerManager.value?.containers.value ?? []);
const isLoading = computed(() => dockerManager.value?.isLoading.value ?? false);
const error = computed(() => dockerManager.value?.error.value ?? null);
const isDockerAvailable = computed(() => dockerManager.value?.isDockerAvailable.value ?? false); // Default to false if no manager
const expandedContainerIds = computed(() => dockerManager.value?.expandedContainerIds.value ?? new Set<string>());

// --- Computed properties for UI state (independent of dockerManager) ---
const currentSessionId = computed(() => activeSession.value?.sessionId);
const sshConnectionStatus = computed(() => activeSession.value?.wsManager.connectionStatus.value ?? 'disconnected');

// --- 格式化容器名称 ---
const formatContainerName = (names?: readonly string[] | string[]) => {
  if (!names || names.length === 0) return 'N/A';
  return names.map(n => (n.startsWith('/') ? n.slice(1) : n)).join(', ');
};

// --- 即时搜索过滤容器列表 ---
const filteredContainers = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return containers.value;
  return containers.value.filter(container => {
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
    const command = `docker exec -it ${containerId} sh\n`; // \n for auto-execution
    emitWorkspaceEvent('terminal:sendCommand', { command, sessionId: activeSession.value.sessionId });
  }
};

const viewContainerLogs = (containerId: string) => {
  if (activeSession.value?.sessionId) {
    const command = `docker logs --tail 1000 -f ${containerId}\n`; // \n for auto-execution
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
      <!-- 顶部操作栏 / 搜索栏 -->
      <div class="docker-toolbar flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-header/40 shrink-0">
        <!-- 搜索输入框 -->
        <div class="relative flex-1 max-w-xs sm:max-w-sm">
          <i class="fas fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-text-secondary/60 pointer-events-none"></i>
          <input
            type="text"
            v-model="searchQuery"
            :placeholder="t('dockerManager.searchPlaceholder', '搜索容器名称、镜像或 ID...')"
            class="w-full pl-8 pr-7 py-1 text-xs bg-background border border-border rounded-md text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all"
            @keydown.esc="clearSearch"
          />
          <!-- 一键清空按钮 -->
          <button
            v-if="searchQuery"
            type="button"
            @click="clearSearch"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-xs p-0.5 rounded cursor-pointer transition-colors"
            :title="t('dockerManager.clearSearch', '清空搜索')"
          >
            <i class="fas fa-times-circle"></i>
          </button>
        </div>

        <!-- 数量统计与刷新按钮 -->
        <div class="flex items-center gap-2 shrink-0 text-xs text-text-secondary">
          <span v-if="containers.length > 0" class="text-[11px] select-none hidden sm:inline-block">
            <template v-if="searchQuery.trim()">
              {{ t('dockerManager.filteredCount', { filtered: filteredContainers.length, total: containers.length }) }}
            </template>
            <template v-else>
              {{ t('dockerManager.containerCount', { count: containers.length }) }}
            </template>
          </span>
          <button
            @click="refreshContainers"
            :disabled="isLoading"
            class="p-1.5 text-xs text-text-secondary hover:text-foreground hover:bg-header/60 rounded border border-border/60 transition-colors cursor-pointer disabled:opacity-50"
            :title="t('common.refresh', '刷新')"
          >
            <i :class="['fas fa-sync-alt', isLoading ? 'fa-spin text-primary' : '']"></i>
          </button>
        </div>
      </div>

      <!-- 容器内容滚动区域 -->
      <div class="docker-content-area flex-grow overflow-auto">
        <!-- 暂无容器 -->
        <div v-if="containers.length === 0 && !isLoading" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary h-full p-6">
          <i class="fab fa-docker text-4xl mb-3 opacity-30"></i>
          <p class="font-medium">{{ t('dockerManager.noContainers') }}</p>
        </div>

        <!-- 搜索无结果 -->
        <div v-else-if="filteredContainers.length === 0 && searchQuery.trim()" class="flex flex-col justify-center items-center text-center flex-grow text-text-secondary h-full p-6">
          <i class="fas fa-search text-3xl mb-3 opacity-30"></i>
          <p class="text-sm font-medium text-foreground mb-1">
            {{ t('dockerManager.noMatchingContainers', '未找到匹配的容器') }}
          </p>
          <p class="text-xs text-text-secondary mb-3">
            {{ t('dockerManager.noMatchingHint', { query: searchQuery }) }}
          </p>
          <button
            @click="clearSearch"
            class="px-3 py-1 text-xs rounded border border-border hover:bg-header/60 text-foreground transition-colors cursor-pointer"
          >
            {{ t('dockerManager.clearSearch', '清空搜索') }}
          </button>
        </div>

        <!-- 容器表格 -->
        <table v-else class="w-full border-collapse text-sm">
          <thead class="responsive-thead">
            <tr class="bg-header">
              <th class="w-8 px-2 py-2 border-b border-border"></th> <!-- Expand Col -->
              <th class="px-3 py-2 border-b border-border text-left font-medium text-text-secondary uppercase tracking-wider">{{ t('dockerManager.header.name') }}</th>
              <th class="px-3 py-2 border-b border-border text-left font-medium text-text-secondary uppercase tracking-wider">{{ t('dockerManager.header.image') }}</th>
              <th class="px-3 py-2 border-b border-border text-left font-medium text-text-secondary uppercase tracking-wider">{{ t('dockerManager.header.status') }}</th>
              <th class="px-3 py-2 border-b border-border text-left font-medium text-text-secondary uppercase tracking-wider">{{ t('dockerManager.header.ports') }}</th>
              <th class="px-3 py-2 border-b border-border text-left font-medium text-text-secondary uppercase tracking-wider">{{ t('dockerManager.header.actions') }}</th>
            </tr>
          </thead>
          <!-- Use template v-for to render pairs of rows -->
          <tbody class="responsive-tbody">
            <template v-for="container in filteredContainers" :key="container.id">
              <!-- Main Row / Card Container -->
              <tr class="responsive-tr mb-4 border border-border rounded p-3 bg-background shadow-sm relative hover:bg-header/30 transition-colors duration-150"
                  :class="{'expanded': expandedContainerIds.has(container.id)}">
                <!-- Expand Button Cell (Desktop only) -->
                <td class="responsive-td-expand w-8 px-2 py-2 border-b border-border text-center align-middle">
                  <button @click="toggleExpand(container.id)" class="text-text-secondary hover:text-foreground transition-colors duration-150 p-1 text-xs" :title="expandedContainerIds.has(container.id) ? t('common.collapse') : t('common.expand')">
                    <i :class="['fas', expandedContainerIds.has(container.id) ? 'fa-chevron-down' : 'fa-chevron-right']"></i>
                  </button>
                </td>
                <!-- Name Cell -->
                <td class="responsive-td px-3 py-2 border-b border-border align-middle text-right" :data-label="t('dockerManager.header.name')">
                  <span class="font-medium text-foreground">{{ formatContainerName(container.Names) }}</span>
                </td>
                <!-- Image Cell -->
                <td class="responsive-td px-3 py-2 border-b border-border align-middle text-right break-all" :data-label="t('dockerManager.header.image')">
                  {{ container.Image }}
                </td>
                <!-- Status Cell -->
                <td class="responsive-td px-3 py-2 border-b border-border align-middle text-right" :data-label="t('dockerManager.header.status')">
                    <span :class="['px-2 py-0.5 rounded-full text-xs font-medium text-white whitespace-nowrap',
                                   container.State === 'running' ? 'bg-green-500' :
                                   container.State === 'exited' ? 'bg-red-500' :
                                   container.State === 'paused' ? 'bg-yellow-500 text-gray-800' :
                                   container.State === 'restarting' ? 'bg-blue-500' :
                                   'bg-gray-500']">
                        {{ container.Status }}
                    </span>
                </td>
                <!-- Ports Cell -->
                <td class="responsive-td px-3 py-2 border-b border-border align-middle text-right break-all" :data-label="t('dockerManager.header.ports')">
                  {{ container.Ports?.map(p => `${p.IP ? p.IP + ':' : ''}${p.PublicPort ? p.PublicPort + '->' : ''}${p.PrivatePort}/${p.Type}`).join(', ') || 'N/A' }}
                </td>
                <!-- Actions Cell -->
                <td class="responsive-td px-3 py-2 border-b border-border align-middle text-right" :data-label="t('dockerManager.header.actions')">
                  <div class="responsive-actions-container flex justify-end gap-2 flex-wrap pt-2">
                    <button @click="sendDockerCommand(container.id, 'start')" :title="t('dockerManager.action.start')" class="text-text-secondary hover:text-green-500 disabled:text-text-disabled disabled:cursor-not-allowed transition-colors duration-150 p-0.5 text-base cursor-pointer" :disabled="container.State === 'running'">
                      <i class="fas fa-play"></i>
                    </button>
                    <button @click="sendDockerCommand(container.id, 'stop')" :title="t('dockerManager.action.stop')" class="text-text-secondary hover:text-yellow-500 disabled:text-text-disabled disabled:cursor-not-allowed transition-colors duration-150 p-0.5 text-base cursor-pointer" :disabled="container.State !== 'running'">
                       <i class="fas fa-stop"></i>
                    </button>
                    <button @click="sendDockerCommand(container.id, 'restart')" :title="t('dockerManager.action.restart')" class="text-text-secondary hover:text-blue-500 disabled:text-text-disabled disabled:cursor-not-allowed transition-colors duration-150 p-0.5 text-base cursor-pointer" :disabled="container.State !== 'running'">
                       <i class="fas fa-sync-alt"></i>
                    </button>
                     <button @click="sendDockerCommand(container.id, 'remove')" :title="t('dockerManager.action.remove')" class="text-text-secondary hover:text-red-500 disabled:text-text-disabled disabled:cursor-not-allowed transition-colors duration-150 p-0.5 text-base cursor-pointer">
                       <i class="fas fa-trash-alt"></i>
                    </button>
                    <button @click="enterContainer(container.id)" :title="t('dockerManager.action.enter')" class="text-text-secondary hover:text-blue-400 transition-colors duration-150 p-0.5 text-base cursor-pointer">
                      <i class="fas fa-terminal"></i>
                    </button>
                    <button @click="viewContainerLogs(container.id)" :title="t('dockerManager.action.logs')" class="text-text-secondary hover:text-gray-400 transition-colors duration-150 p-0.5 text-base cursor-pointer">
                      <i class="fas fa-file-alt"></i>
                    </button>
                  </div>
                </td>

                <!-- Card Expansion Cell (Mobile only) -->
                <td class="responsive-td-card-expand w-full p-0 border-t border-border mt-3">
                  <!-- Card Footer Button (Show when NOT expanded) -->
                  <div v-if="!expandedContainerIds.has(container.id)">
                     <button @click="toggleExpand(container.id)" class="flex items-center justify-center w-full h-10 text-text-secondary hover:text-foreground hover:bg-header/50 transition-colors duration-150 text-sm rounded-b cursor-pointer">
                       <i class="fas fa-chevron-down mr-1.5"></i> {{ t('common.expand') }}
                     </button>
                  </div>
                  <!-- Card Expansion Content (Show when expanded) -->
                  <div v-if="expandedContainerIds.has(container.id)" class="bg-header/30 rounded-b">
                     <div class="p-4">
                        <dl v-if="container.stats" class="grid grid-cols-[max-content_auto] gap-x-4 gap-y-2 text-xs">
                          <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.cpu') }}</dt>
                          <dd class="font-mono">{{ container.stats.CPUPerc ?? 'N/A' }}</dd>
                          <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.memory') }}</dt>
                          <dd class="font-mono">{{ container.stats.MemUsage ?? 'N/A' }} ({{ container.stats.MemPerc ?? 'N/A' }})</dd>
                          <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.netIO') }}</dt>
                          <dd class="font-mono">{{ container.stats.NetIO ?? 'N/A' }}</dd>
                          <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.blockIO') }}</dt>
                          <dd class="font-mono">{{ container.stats.BlockIO ?? 'N/A' }}</dd>
                          <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.pids') }}</dt>
                          <dd class="font-mono">{{ container.stats.PIDs ?? 'N/A' }}</dd>
                        </dl>
                        <div v-else class="text-center text-text-secondary italic text-xs py-2">
                            {{ t('dockerManager.stats.noData') }}
                        </div>
                     </div>
                     <!-- Collapse Button for Card View -->
                     <button @click="toggleExpand(container.id)" class="flex items-center justify-center w-full h-10 text-text-secondary hover:text-foreground hover:bg-header/50 transition-colors duration-150 text-sm border-t border-border rounded-b cursor-pointer">
                         <i class="fas fa-chevron-up mr-1.5"></i> {{ t('common.collapse') }}
                     </button>
                  </div>
                </td>
              </tr>

            <!-- Desktop Expansion Row (Hidden on mobile) -->
            <tr v-if="expandedContainerIds.has(container.id)" class="responsive-expansion-row">
              <td :colspan="6" class="p-0 border-b border-border">
                <div class="bg-header/30 p-4">
                  <dl v-if="container.stats" class="grid grid-cols-[max-content_auto] gap-x-4 gap-y-2 text-xs">
                    <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.cpu') }}</dt>
                    <dd class="font-mono">{{ container.stats.CPUPerc ?? 'N/A' }}</dd>
                    <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.memory') }}</dt>
                    <dd class="font-mono">{{ container.stats.MemUsage ?? 'N/A' }} ({{ container.stats.MemPerc ?? 'N/A' }})</dd>
                    <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.netIO') }}</dt>
                    <dd class="font-mono">{{ container.stats.NetIO ?? 'N/A' }}</dd>
                    <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.blockIO') }}</dt>
                    <dd class="font-mono">{{ container.stats.BlockIO ?? 'N/A' }}</dd>
                    <dt class="font-medium text-text-secondary">{{ t('dockerManager.stats.pids') }}</dt>
                    <dd class="font-mono">{{ container.stats.PIDs ?? 'N/A' }}</dd>
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
/* Define the component root as a size container */
.docker-manager {
  container-type: inline-size;
  container-name: docker-manager-pane;
}

/* --- Responsive Table Styles using Container Query --- */

/* Default styles (Table view) */
.responsive-thead { display: table-header-group; }
.responsive-tbody { display: table-row-group; }
.responsive-tr { display: table-row; }
.responsive-td { display: table-cell; vertical-align: middle; }
.responsive-td-expand { display: table-cell; vertical-align: middle; }
.responsive-td-card-expand { display: none; }
.responsive-expansion-row { display: table-row; }
.responsive-actions-container { justify-content: flex-start; }

/* Styles for Card View when container is narrow */
@container docker-manager-pane (max-width: 600px) {
  .docker-content-area {
    padding: 1rem;
  }

  .responsive-thead.responsive-thead {
    display: none;
  }

  .responsive-tbody.responsive-tbody {
    display: block;
  }

  .responsive-tr.responsive-tr {
    display: block;
    margin-bottom: 1rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    padding: 0.75rem;
    background-color: var(--app-bg-color);
  }

  .responsive-td.responsive-td {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-color);
    padding: 0.5rem 0;
    text-align: right;
  }
  .responsive-tr.responsive-tr .responsive-td.responsive-td:last-of-type {
      border-bottom: none;
  }

  .responsive-td.responsive-td::before {
    content: attr(data-label);
    font-weight: 500;
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
  }
}
</style>
