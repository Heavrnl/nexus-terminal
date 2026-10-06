<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import { useConfirmDialog } from '../composables/useConfirmDialog';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();
const { activeSession } = storeToRefs(sessionStore);
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const { showConfirmDialog } = useConfirmDialog();

// --- 搜索与过滤状态 ---
const searchQuery = ref('');
const statusFilter = ref<'all' | 'running' | 'exited'>('all');

// --- 从当前活动会话获取 Docker 管理器 ---
const dockerManager = computed(() => activeSession.value?.dockerManager);
const containers = computed(() => dockerManager.value?.containers.value ?? []);
const isLoading = computed(() => dockerManager.value?.isLoading.value ?? false);
const error = computed(() => dockerManager.value?.error.value ?? null);
const isDockerAvailable = computed(() => dockerManager.value?.isDockerAvailable.value ?? false);
const expandedContainerIds = computed(() => dockerManager.value?.expandedContainerIds.value ?? new Set<string>());

const currentSessionId = computed(() => activeSession.value?.sessionId);
const sshConnectionStatus = computed(() => activeSession.value?.wsManager.connectionStatus.value ?? 'disconnected');

// 格式化容器名称
const formatContainerName = (names?: readonly string[] | string[]) => {
  if (!names || names.length === 0) return '未命名容器';
  return names.map(n => (n.startsWith('/') ? n.slice(1) : n)).join(', ');
};

// 过滤后的容器列表
const filteredContainers = computed(() => {
  let list = containers.value;

  // 状态过滤
  if (statusFilter.value === 'running') {
    list = list.filter(c => c.State === 'running');
  } else if (statusFilter.value === 'exited') {
    list = list.filter(c => c.State !== 'running');
  }

  // 搜索词过滤
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return list;

  return list.filter(container => {
    const matchName = container.Names?.some(name => {
      const lower = name.toLowerCase();
      const clean = lower.startsWith('/') ? lower.slice(1) : lower;
      return clean.includes(query) || lower.includes(query);
    });
    const matchImage = container.Image?.toLowerCase().includes(query);
    const matchId = container.id?.toLowerCase().includes(query);
    return Boolean(matchName || matchImage || matchId);
  });
});

// 清空搜索
const clearSearch = () => {
  searchQuery.value = '';
};

// 刷新容器
const refreshContainers = () => {
  dockerManager.value?.requestDockerStatus();
};

// 执行 Docker 命令
const handleDockerCommand = async (containerId: string, command: 'start' | 'stop' | 'restart' | 'remove') => {
  if (command === 'remove') {
    const confirmed = await showConfirmDialog({
      title: t('dockerManager.confirmRemoveTitle', '删除容器'),
      message: t('dockerManager.confirmRemoveMessage', '确认要彻底删除该容器吗？此操作无法撤销。'),
      confirmText: t('common.delete', '删除'),
      cancelText: t('common.cancel', '取消'),
    });
    if (!confirmed) return;
  }
  dockerManager.value?.sendDockerCommand(containerId, command);
};

// 展开/收回性能指标
const toggleExpand = (containerId: string) => {
  dockerManager.value?.toggleExpand(containerId);
};

// 关闭抽屉
const handleClose = () => {
  emit('close');
};

// 终端进入容器（点击后发送指令并关闭抽屉以呈现全屏终端）
const enterContainer = (containerId: string) => {
  if (activeSession.value?.sessionId) {
    const command = `docker exec -it ${containerId} sh\n`;
    emitWorkspaceEvent('terminal:sendCommand', { command, sessionId: activeSession.value.sessionId });
    handleClose();
  }
};

// 查看容器实时日志（点击后发送指令并关闭抽屉）
const viewContainerLogs = (containerId: string) => {
  if (activeSession.value?.sessionId) {
    const command = `docker logs --tail 1000 -f ${containerId}\n`;
    emitWorkspaceEvent('terminal:sendCommand', { command, sessionId: activeSession.value.sessionId });
    handleClose();
  }
};
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        v-if="isVisible"
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="handleClose"
      >
        <!-- 移动端底部滑出面板 (Bottom Sheet) -->
        <div class="mobile-docker-sheet w-full h-[85vh] max-h-[90vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden">
          <!-- 顶部拖拽手柄指示条 -->
          <div
            class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
            @click="handleClose"
            title="点击收起"
          >
            <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
          </div>

          <!-- 顶栏标题与操作 -->
          <div class="sheet-header flex items-center justify-between px-4 py-2.5 border-b border-border/50 shrink-0">
            <div class="flex items-center gap-2">
              <div class="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center">
                <i class="fab fa-docker text-base"></i>
              </div>
              <h3 class="text-base font-semibold text-foreground tracking-tight">
                {{ t('dockerManager.title', 'Docker 管理器') }}
              </h3>
              <span
                v-if="containers.length > 0"
                class="px-2 py-0.5 rounded-full text-[11px] font-mono bg-border/40 text-text-secondary"
              >
                {{ containers.length }}
              </span>
            </div>

            <div class="flex items-center gap-2">
              <!-- 手动刷新按钮 -->
              <button
                @click="refreshContainers"
                :disabled="isLoading"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer disabled:opacity-40"
                :title="t('common.refresh', '刷新')"
              >
                <i :class="['fas fa-sync-alt text-xs', isLoading ? 'fa-spin text-primary' : '']"></i>
              </button>

              <!-- 收起按钮 -->
              <button
                @click="handleClose"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
                :title="t('common.close', '收起')"
              >
                <i class="fas fa-chevron-down text-sm"></i>
              </button>
            </div>
          </div>

          <!-- 移动端搜索与状态过滤栏 -->
          <div class="px-3.5 py-2.5 bg-header/20 border-b border-border/40 shrink-0 space-y-2">
            <!-- 搜索框 -->
            <div class="relative flex items-center w-full">
              <i class="fas fa-search absolute left-3 text-xs text-text-secondary/60 pointer-events-none"></i>
              <input
                type="text"
                v-model="searchQuery"
                :placeholder="t('dockerManager.searchPlaceholder', '搜索容器名称、镜像或 ID...')"
                class="w-full pl-8 pr-8 py-1.5 text-xs bg-background border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all font-mono shadow-2xs"
              />
              <button
                v-if="searchQuery"
                @click="clearSearch"
                class="absolute right-2.5 text-text-secondary/60 hover:text-foreground p-0.5 cursor-pointer"
              >
                <i class="fas fa-times-circle text-xs"></i>
              </button>
            </div>

            <!-- 状态快速筛选药丸组 -->
            <div class="flex items-center gap-1.5 text-xs">
              <button
                @click="statusFilter = 'all'"
                class="px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer"
                :class="statusFilter === 'all' ? 'bg-primary text-primary-foreground shadow-2xs' : 'bg-background border border-border/50 text-text-secondary'"
              >
                全部 ({{ containers.length }})
              </button>
              <button
                @click="statusFilter = 'running'"
                class="px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                :class="statusFilter === 'running' ? 'bg-emerald-500 text-white shadow-2xs' : 'bg-background border border-border/50 text-text-secondary'"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                <span>运行中 ({{ containers.filter(c => c.State === 'running').length }})</span>
              </button>
              <button
                @click="statusFilter = 'exited'"
                class="px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                :class="statusFilter === 'exited' ? 'bg-rose-500 text-white shadow-2xs' : 'bg-background border border-border/50 text-text-secondary'"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
                <span>已停止 ({{ containers.filter(c => c.State !== 'running').length }})</span>
              </button>
            </div>
          </div>

          <!-- 内容主体可滚动区域 -->
          <div class="sheet-body flex-grow overflow-y-auto px-3.5 py-3 space-y-3 overscroll-contain">
            <!-- 异常状态处理 -->
            <!-- 1. 无活动 SSH 会话 -->
            <div
              v-if="!currentSessionId"
              class="flex flex-col items-center justify-center py-16 text-center text-text-secondary space-y-2.5"
            >
              <div class="w-14 h-14 rounded-full bg-header/40 flex items-center justify-center text-text-secondary/60">
                <i class="fas fa-plug text-2xl"></i>
              </div>
              <p class="text-sm font-medium text-foreground">{{ t('dockerManager.error.noActiveSession', '无活动 SSH 会话') }}</p>
              <p class="text-xs text-text-secondary max-w-xs">{{ t('dockerManager.error.connectFirst', '请先连接到服务器终端以管理 Docker 容器。') }}</p>
            </div>

            <!-- 2. SSH 连接中 -->
            <div
              v-else-if="sshConnectionStatus === 'connecting'"
              class="flex flex-col items-center justify-center py-16 text-center text-text-secondary space-y-2.5"
            >
              <i class="fas fa-circle-notch fa-spin text-3xl text-primary"></i>
              <p class="text-xs font-medium">{{ t('dockerManager.waitingForSsh', '正在等待 SSH 连接建立...') }}</p>
            </div>

            <!-- 3. SSH 已断开 -->
            <div
              v-else-if="sshConnectionStatus === 'disconnected'"
              class="flex flex-col items-center justify-center py-16 text-center text-text-secondary space-y-2.5"
            >
              <i class="fas fa-unlink text-3xl opacity-40"></i>
              <p class="text-sm font-medium">{{ t('dockerManager.error.sshDisconnected', 'SSH 连接已断开') }}</p>
            </div>

            <!-- 4. Docker 加载中且无历史数据 -->
            <div
              v-else-if="isLoading && containers.length === 0"
              class="flex flex-col items-center justify-center py-16 text-center text-text-secondary space-y-2.5"
            >
              <i class="fas fa-circle-notch fa-spin text-3xl text-primary"></i>
              <p class="text-xs font-medium">{{ t('dockerManager.loading', '正在获取 Docker 容器列表...') }}</p>
            </div>

            <!-- 5. Docker 未安装或未启动 -->
            <div
              v-else-if="!isDockerAvailable"
              class="flex flex-col items-center justify-center py-14 text-center text-text-secondary space-y-2.5 px-4"
            >
              <div class="w-14 h-14 rounded-full bg-header/40 flex items-center justify-center text-text-secondary/60">
                <i class="fab fa-docker text-3xl"></i>
              </div>
              <p class="text-sm font-medium text-foreground">{{ t('dockerManager.notAvailable', '未检测到 Docker 服务') }}</p>
              <p class="text-xs text-text-secondary max-w-xs">{{ t('dockerManager.installHintRemote', '目标服务器上未安装 Docker 或 Docker 守护进程未启动。') }}</p>
            </div>

            <!-- 6. 容器列表为空 -->
            <div
              v-else-if="containers.length === 0 && !isLoading"
              class="flex flex-col items-center justify-center py-16 text-center text-text-secondary space-y-2"
            >
              <i class="fab fa-docker text-4xl opacity-30"></i>
              <p class="text-sm font-medium text-foreground">{{ t('dockerManager.noContainers', '当前没有任何容器') }}</p>
            </div>

            <!-- 7. 搜索无匹配 -->
            <div
              v-else-if="filteredContainers.length === 0 && searchQuery.trim()"
              class="flex flex-col items-center justify-center py-14 text-center text-text-secondary space-y-3"
            >
              <i class="fas fa-search text-3xl opacity-30"></i>
              <p class="text-sm font-medium text-foreground">未找到匹配的容器</p>
              <button
                @click="clearSearch"
                class="px-3 py-1 text-xs rounded-lg border border-border bg-header/40 text-foreground cursor-pointer"
              >
                清空搜索条件
              </button>
            </div>

            <!-- 8. 正常容器卡片流 -->
            <template v-else>
              <div
                v-for="container in filteredContainers"
                :key="container.id"
                class="rounded-xl bg-header/25 border border-border/50 p-3.5 space-y-3 shadow-2xs transition-all"
              >
                <!-- 卡片顶栏：名称与状态胶囊 -->
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="text-sm font-bold text-foreground tracking-tight break-all">
                        {{ formatContainerName(container.Names) }}
                      </span>
                    </div>
                    <!-- 镜像名称 -->
                    <div class="text-[11px] font-mono text-text-secondary truncate mt-0.5" :title="container.Image">
                      {{ container.Image }}
                    </div>
                  </div>

                  <!-- 运行状态胶囊 -->
                  <div
                    class="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold flex items-center gap-1 shadow-2xs"
                    :class="[
                      container.State === 'running' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' :
                      container.State === 'exited' ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30' :
                      container.State === 'paused' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' :
                      'bg-neutral-500/15 text-neutral-400 border border-neutral-500/30'
                    ]"
                  >
                    <span
                      class="w-1.5 h-1.5 rounded-full"
                      :class="container.State === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'"
                    ></span>
                    <span>{{ container.Status || container.State }}</span>
                  </div>
                </div>

                <!-- 端口映射信息 (如有) -->
                <div
                  v-if="container.Ports && container.Ports.length > 0"
                  class="flex items-center gap-1 flex-wrap text-[11px] font-mono pt-0.5"
                >
                  <span class="text-text-secondary/70 text-[10px] mr-1">端口:</span>
                  <span
                    v-for="(port, pIdx) in container.Ports.slice(0, 4)"
                    :key="pIdx"
                    class="px-1.5 py-0.2 rounded bg-background/80 border border-border/40 text-text-secondary text-[10px]"
                  >
                    {{ port.PublicPort ? `${port.PublicPort}->${port.PrivatePort}` : port.PrivatePort }}/{{ port.Type }}
                  </span>
                  <span v-if="container.Ports.length > 4" class="text-[10px] text-text-secondary">
                    +{{ container.Ports.length - 4 }}
                  </span>
                </div>

                <!-- 操作按钮组 (移动端大触控热区) -->
                <div class="flex items-center justify-between gap-1 pt-1 border-t border-border/30">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <!-- 启动 -->
                    <button
                      v-if="container.State !== 'running'"
                      @click="handleDockerCommand(container.id, 'start')"
                      class="h-8 px-2.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 active:scale-95 text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                    >
                      <i class="fas fa-play text-[10px]"></i>
                      <span>启动</span>
                    </button>

                    <!-- 停止 -->
                    <button
                      v-if="container.State === 'running'"
                      @click="handleDockerCommand(container.id, 'stop')"
                      class="h-8 px-2.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 active:scale-95 text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                    >
                      <i class="fas fa-stop text-[10px]"></i>
                      <span>停止</span>
                    </button>

                    <!-- 重启 -->
                    <button
                      v-if="container.State === 'running'"
                      @click="handleDockerCommand(container.id, 'restart')"
                      class="h-8 px-2.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/30 hover:bg-sky-500/20 active:scale-95 text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                    >
                      <i class="fas fa-sync-alt text-[10px]"></i>
                      <span>重启</span>
                    </button>

                    <!-- 终端进入 (sh) -->
                    <button
                      @click="enterContainer(container.id)"
                      class="h-8 px-2.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/20 active:scale-95 text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                      title="打开终端进入容器内部命令行"
                    >
                      <i class="fas fa-terminal text-[10px]"></i>
                      <span>终端</span>
                    </button>

                    <!-- 查看实时日志 -->
                    <button
                      @click="viewContainerLogs(container.id)"
                      class="h-8 px-2.5 rounded-lg bg-background border border-border/60 text-text-secondary hover:text-foreground active:scale-95 text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                      title="在终端查看容器实时滚动日志"
                    >
                      <i class="fas fa-file-alt text-[10px]"></i>
                      <span>日志</span>
                    </button>
                  </div>

                  <div class="flex items-center gap-1">
                    <!-- 删除 -->
                    <button
                      @click="handleDockerCommand(container.id, 'remove')"
                      class="w-8 h-8 rounded-lg text-text-secondary hover:text-rose-400 hover:bg-rose-500/10 active:scale-95 flex items-center justify-center transition-all cursor-pointer"
                      title="删除容器"
                    >
                      <i class="fas fa-trash-alt text-xs"></i>
                    </button>

                    <!-- 展开性能指标 -->
                    <button
                      @click="toggleExpand(container.id)"
                      class="w-8 h-8 rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 flex items-center justify-center transition-all cursor-pointer"
                      :title="expandedContainerIds.has(container.id) ? '收起性能指标' : '查看实时 CPU/内存/IO 指标'"
                    >
                      <i :class="['fas text-xs transition-transform', expandedContainerIds.has(container.id) ? 'fa-chevron-up text-primary' : 'fa-chart-pie']"></i>
                    </button>
                  </div>
                </div>

                <!-- 性能指标展开区域 (Stats Panel) -->
                <div
                  v-if="expandedContainerIds.has(container.id)"
                  class="p-2.5 rounded-lg bg-background/80 border border-border/40 space-y-2 text-xs"
                >
                  <div class="text-[10px] font-semibold text-text-secondary flex items-center justify-between">
                    <span>实时性能统计 (Stats)</span>
                    <span v-if="container.stats" class="text-emerald-400 font-mono text-[9px]">LIVE</span>
                  </div>

                  <div v-if="container.stats" class="grid grid-cols-2 gap-2 text-[11px]">
                    <div class="p-1.5 rounded bg-header/40 border border-border/30">
                      <div class="text-[10px] text-text-secondary">CPU 占用率</div>
                      <div class="font-mono font-bold text-foreground mt-0.5">{{ container.stats.CPUPerc ?? 'N/A' }}</div>
                    </div>
                    <div class="p-1.5 rounded bg-header/40 border border-border/30">
                      <div class="text-[10px] text-text-secondary">内存用量 (占比)</div>
                      <div class="font-mono font-bold text-foreground mt-0.5 truncate">{{ container.stats.MemUsage ?? 'N/A' }} ({{ container.stats.MemPerc ?? '0%' }})</div>
                    </div>
                    <div class="p-1.5 rounded bg-header/40 border border-border/30">
                      <div class="text-[10px] text-text-secondary">网络 I/O</div>
                      <div class="font-mono font-medium text-foreground mt-0.5 truncate">{{ container.stats.NetIO ?? 'N/A' }}</div>
                    </div>
                    <div class="p-1.5 rounded bg-header/40 border border-border/30">
                      <div class="text-[10px] text-text-secondary">磁盘 I/O / 进程数</div>
                      <div class="font-mono font-medium text-foreground mt-0.5 truncate">{{ container.stats.BlockIO ?? '0B' }} / {{ container.stats.PIDs ?? 0 }}</div>
                    </div>
                  </div>

                  <div v-else class="text-center py-2 text-text-secondary/70 italic text-[11px]">
                    正在拉取容器实时统计数据...
                  </div>
                </div>
              </div>
            </template>

            <!-- 底部安全区垫高 -->
            <div class="sheet-safe-bottom"></div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}
</style>
