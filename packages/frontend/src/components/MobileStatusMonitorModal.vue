<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useSettingsStore } from '../stores/settings.store';
import { useConnectionsStore } from '../stores/connections.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import StatusCharts from './StatusCharts.vue';

interface ServerStatus {
  cpuPercent?: number;
  memPercent?: number;
  memUsed?: number; // MB
  memTotal?: number; // MB
  swapPercent?: number;
  swapUsed?: number; // MB
  swapTotal?: number; // MB
  diskPercent?: number;
  diskUsed?: number; // KB
  diskTotal?: number; // KB
  cpuModel?: string;
  netRxRate?: number; // 字节/秒
  netTxRate?: number; // 字节/秒
  netInterface?: string;
  osName?: string;
}

const props = defineProps<{
  isVisible: boolean;
  activeSessionId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();
const settingsStore = useSettingsStore();
const connectionsStore = useConnectionsStore();
const uiNotificationsStore = useUiNotificationsStore();

const { sessions } = storeToRefs(sessionStore);
const { statusMonitorShowIpBoolean } = storeToRefs(settingsStore);

// 获取当前活动会话
const currentSessionState = computed(() => {
  return props.activeSessionId ? sessions.value.get(props.activeSessionId) : null;
});

// 获取服务器状态数据
const currentServerStatus = computed<ServerStatus | null>(() => {
  return currentSessionState.value?.statusMonitorManager?.serverStatus?.value ?? null;
});

const currentStatusError = computed<string | null>(() => {
  return currentSessionState.value?.statusMonitorManager?.statusError?.value ?? null;
});

// 获取当前连接信息
const currentConnectionInfo = computed(() => {
  const sessionState = currentSessionState.value;
  if (!sessionState || !sessionState.connectionId) return null;
  const connectionIdAsNumber = parseInt(sessionState.connectionId, 10);
  if (isNaN(connectionIdAsNumber)) return null;
  return connectionsStore.connections.find(conn => conn.id === connectionIdAsNumber) || null;
});

// 获取当前会话 IP 地址
const sessionIpAddress = computed(() => {
  return currentConnectionInfo.value?.host || null;
});

// 获取当前会话名称
const sessionConnectionName = computed(() => {
  return currentConnectionInfo.value?.name || (props.activeSessionId ? `会话 ${props.activeSessionId}` : '当前主机');
});

// 缓存 CPU 型号与系统名称
const cachedCpuModel = ref<string | null>(null);
const cachedOsName = ref<string | null>(null);

watch(currentServerStatus, (newData) => {
  if (newData) {
    if (newData.cpuModel && newData.cpuModel !== cachedCpuModel.value) {
      cachedCpuModel.value = newData.cpuModel;
    }
    if (newData.osName && newData.osName !== cachedOsName.value) {
      cachedOsName.value = newData.osName;
    }
  }
}, { immediate: true });

const displayCpuModel = computed(() => {
  return (currentServerStatus.value?.cpuModel ?? cachedCpuModel.value) || t('statusMonitor.notAvailable', '未知型号');
});

const displayOsName = computed(() => {
  return (currentServerStatus.value?.osName ?? cachedOsName.value) || t('statusMonitor.notAvailable', 'Linux');
});

// 格式化网络速率
const formatBytesPerSecond = (bytes?: number) => {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B/s';
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
};

// 格式化容量
const formatDiskSize = (kb?: number) => {
  if (kb === undefined || kb === null || isNaN(kb)) return '--';
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  if (gb < 1000) return `${gb.toFixed(1)} GB`;
  const tb = gb / 1024;
  return `${tb.toFixed(2)} TB`;
};

const formatMemorySize = (mb?: number) => {
  if (mb === undefined || mb === null || isNaN(mb)) return '--';
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
};

// 复制 IP 地址
const copyIpToClipboard = async (ip: string) => {
  try {
    await navigator.clipboard.writeText(ip);
    uiNotificationsStore.showSuccess(t('statusMonitor.ipCopied', 'IP 地址已复制'));
  } catch (err) {
    uiNotificationsStore.showError(t('statusMonitor.copyIpError', '复制 IP 失败'));
  }
};

// 渐变进度条颜色：统一根据百分比从绿色（安全）-> 橙黄（预警）-> 红色（高负荷）
const getProgressGradient = (percent: number) => {
  if (percent > 80) {
    return 'bg-gradient-to-r from-orange-500 to-rose-500';
  }
  if (percent > 60) {
    return 'bg-gradient-to-r from-amber-400 to-amber-500';
  }
  return 'bg-gradient-to-r from-emerald-500 to-green-500';
};

const handleClose = () => {
  emit('close');
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
        <div class="mobile-status-sheet w-full h-[85vh] max-h-[90vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden">
          <!-- 顶部拖拽手柄指示条 -->
          <div
            class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
            @click="handleClose"
            title="点击收起"
          >
            <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
          </div>

          <!-- 顶栏标题与关闭操作 -->
          <div class="sheet-header flex items-center justify-between px-4 py-2.5 border-b border-border/50 shrink-0">
            <div class="flex items-center gap-2">
              <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <i class="fas fa-tachometer-alt text-sm"></i>
              </div>
              <h3 class="text-base font-semibold text-foreground tracking-tight">
                {{ t('statusMonitor.title', '状态监视器') }}
              </h3>
            </div>

            <button
              @click="handleClose"
              class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
              :title="t('common.close', '收起')"
            >
              <i class="fas fa-chevron-down text-sm"></i>
            </button>
          </div>

          <!-- 内容主体可滚动区域 -->
          <div class="sheet-body flex-grow overflow-y-auto px-4 py-3 space-y-4 overscroll-contain">
            <!-- Case 1: 无活动会话 -->
            <div
              v-if="!activeSessionId"
              class="flex flex-col items-center justify-center py-16 text-center text-text-secondary space-y-2.5"
            >
              <div class="w-14 h-14 rounded-full bg-header/40 flex items-center justify-center text-text-secondary/60">
                <i class="fas fa-plug text-2xl"></i>
              </div>
              <p class="text-sm font-medium text-foreground">暂无活动 SSH 会话</p>
              <p class="text-xs text-text-secondary max-w-xs">
                请先在终端建立或切换到有效的 SSH 连接，即可查看服务器实时指标。
              </p>
            </div>

            <!-- Case 2: 监控错误 -->
            <div
              v-else-if="currentStatusError"
              class="flex flex-col items-center justify-center py-12 text-center text-rose-500 space-y-2"
            >
              <i class="fas fa-exclamation-triangle text-3xl"></i>
              <p class="text-sm font-medium">{{ t('statusMonitor.errorPrefix', '获取监控数据失败:') }}</p>
              <p class="text-xs text-text-secondary font-mono px-4">{{ currentStatusError }}</p>
            </div>

            <!-- Case 3: 加载中 -->
            <div
              v-else-if="!currentServerStatus"
              class="flex flex-col items-center justify-center py-16 text-center text-text-secondary space-y-3"
            >
              <i class="fas fa-circle-notch fa-spin text-3xl text-primary"></i>
              <p class="text-xs font-medium">{{ t('statusMonitor.loading', '正在采集服务器指标...') }}</p>
            </div>

            <!-- Case 4: 正常数据展示 -->
            <template v-else>
              <!-- 主机概览卡片 -->
              <div class="rounded-xl bg-header/30 border border-border/50 p-3 space-y-2.5 shadow-2xs">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <i class="fas fa-server text-primary text-xs shrink-0"></i>
                    <span class="text-xs font-bold text-foreground truncate">
                      {{ sessionConnectionName }}
                    </span>
                  </div>
                  <!-- IP 复制徽章 -->
                  <button
                    v-if="sessionIpAddress && statusMonitorShowIpBoolean"
                    @click="copyIpToClipboard(sessionIpAddress)"
                    class="shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-background border border-border/60 text-[11px] font-mono text-text-secondary hover:text-primary active:scale-95 transition-all cursor-pointer shadow-2xs"
                    title="点击复制 IP"
                  >
                    <span>{{ sessionIpAddress }}</span>
                    <i class="fas fa-copy text-[10px]"></i>
                  </button>
                </div>

                <!-- 系统与 CPU 详细信息条目：垂直分行全宽舒展展示，杜绝横向挤压截断 -->
                <div class="space-y-1.5 pt-2 border-t border-border/30 text-xs">
                  <!-- 系统条目 -->
                  <div class="flex items-start gap-1.5 leading-snug">
                    <span class="shrink-0 text-text-secondary/70 flex items-center gap-1 min-w-[44px]">
                      <i class="fab fa-linux text-[11px] text-text-secondary"></i>
                      <span>系统:</span>
                    </span>
                    <span class="font-medium text-foreground break-words flex-1">
                      {{ displayOsName }}
                    </span>
                  </div>
                  <!-- CPU 条目 -->
                  <div class="flex items-start gap-1.5 leading-snug">
                    <span class="shrink-0 text-text-secondary/70 flex items-center gap-1 min-w-[44px]">
                      <i class="fas fa-microchip text-[11px] text-sky-400"></i>
                      <span>CPU:</span>
                    </span>
                    <span class="font-medium text-foreground break-words flex-1 font-mono text-[11px]">
                      {{ displayCpuModel }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- 四大核心指标卡片流 -->
              <div class="grid grid-cols-2 gap-2.5">
                <!-- CPU 卡片 -->
                <div class="rounded-xl bg-header/20 border border-border/50 p-3 space-y-2 shadow-2xs flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-text-secondary">CPU 使用率</span>
                    <i class="fas fa-microchip text-xs text-sky-400"></i>
                  </div>
                  <div>
                    <span class="text-xl font-bold font-mono text-foreground">
                      {{ Math.round(currentServerStatus.cpuPercent ?? 0) }}%
                    </span>
                  </div>
                  <!-- 进度条 -->
                  <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :class="getProgressGradient(currentServerStatus.cpuPercent ?? 0)"
                      :style="{ width: `${Math.min(100, Math.max(0, currentServerStatus.cpuPercent ?? 0))}%` }"
                    ></div>
                  </div>
                  <!-- 底部数值独占一行 -->
                  <div class="flex items-center justify-between text-[10px] font-mono text-text-secondary pt-0.5">
                    <span class="text-text-secondary/70">当前占用</span>
                    <span class="text-text-secondary/90 font-medium">{{ (currentServerStatus.cpuPercent ?? 0).toFixed(1) }}%</span>
                  </div>
                </div>

                <!-- 内存卡片 -->
                <div class="rounded-xl bg-header/20 border border-border/50 p-3 space-y-2 shadow-2xs flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-text-secondary">物理内存</span>
                    <i class="fas fa-memory text-xs text-emerald-400"></i>
                  </div>
                  <div>
                    <span class="text-xl font-bold font-mono text-foreground">
                      {{ Math.round(currentServerStatus.memPercent ?? 0) }}%
                    </span>
                  </div>
                  <!-- 进度条 -->
                  <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :class="getProgressGradient(currentServerStatus.memPercent ?? 0)"
                      :style="{ width: `${Math.min(100, Math.max(0, currentServerStatus.memPercent ?? 0))}%` }"
                    ></div>
                  </div>
                  <!-- 底部数值独占一行：已用 / 总量两端对齐，彻底杜绝截断 -->
                  <div class="flex items-center justify-between text-[10px] font-mono pt-0.5 text-text-secondary">
                    <span>已用 {{ formatMemorySize(currentServerStatus.memUsed) }}</span>
                    <span>共 {{ formatMemorySize(currentServerStatus.memTotal) }}</span>
                  </div>
                </div>

                <!-- Swap 交换区卡片 -->
                <div class="rounded-xl bg-header/20 border border-border/50 p-3 space-y-2 shadow-2xs flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-text-secondary">SWAP 交换区</span>
                    <i class="fas fa-exchange-alt text-xs text-amber-400"></i>
                  </div>
                  <div>
                    <span class="text-xl font-bold font-mono text-foreground">
                      {{ Math.round(currentServerStatus.swapPercent ?? 0) }}%
                    </span>
                  </div>
                  <!-- 进度条 -->
                  <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :style="{ width: `${Math.min(100, Math.max(0, currentServerStatus.swapPercent ?? 0))}%` }"
                      :class="getProgressGradient(currentServerStatus.swapPercent ?? 0)"
                    ></div>
                  </div>
                  <!-- 底部数值独占一行 -->
                  <div class="flex items-center justify-between text-[10px] font-mono pt-0.5 text-text-secondary">
                    <span>已用 {{ (currentServerStatus.swapTotal ?? 0) > 0 ? formatMemorySize(currentServerStatus.swapUsed) : '0 MB' }}</span>
                    <span>{{ (currentServerStatus.swapTotal ?? 0) > 0 ? `共 ${formatMemorySize(currentServerStatus.swapTotal)}` : '未启用' }}</span>
                  </div>
                </div>

                <!-- 磁盘空间卡片 -->
                <div class="rounded-xl bg-header/20 border border-border/50 p-3 space-y-2 shadow-2xs flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-text-secondary">根磁盘空间</span>
                    <i class="fas fa-hdd text-xs text-purple-400"></i>
                  </div>
                  <div>
                    <span class="text-xl font-bold font-mono text-foreground">
                      {{ Math.round(currentServerStatus.diskPercent ?? 0) }}%
                    </span>
                  </div>
                  <!-- 进度条 -->
                  <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :class="getProgressGradient(currentServerStatus.diskPercent ?? 0)"
                      :style="{ width: `${Math.min(100, Math.max(0, currentServerStatus.diskPercent ?? 0))}%` }"
                    ></div>
                  </div>
                  <!-- 底部数值独占一行：已用 / 总量两端对齐，彻底杜绝截断 -->
                  <div class="flex items-center justify-between text-[10px] font-mono pt-0.5 text-text-secondary">
                    <span>已用 {{ formatDiskSize(currentServerStatus.diskUsed) }}</span>
                    <span>共 {{ formatDiskSize(currentServerStatus.diskTotal) }}</span>
                  </div>
                </div>
              </div>

              <!-- 实时网络吞吐条 -->
              <div class="rounded-xl bg-header/20 border border-border/50 p-3 shadow-2xs space-y-2">
                <div class="flex items-center justify-between text-xs">
                  <span class="font-medium text-text-secondary flex items-center gap-1.5">
                    <i class="fas fa-network-wired text-primary"></i>
                    <span>网络吞吐 ({{ currentServerStatus.netInterface || 'eth0' }})</span>
                  </span>
                </div>
                <div class="grid grid-cols-2 gap-3 pt-1">
                  <!-- 下行 (下载) -->
                  <div class="flex items-center gap-2.5 p-2 rounded-lg bg-background/60 border border-border/40">
                    <div class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
                      <i class="fas fa-arrow-down text-xs"></i>
                    </div>
                    <div class="flex flex-col min-w-0">
                      <span class="text-[10px] text-text-secondary/80">下载速率</span>
                      <span class="text-xs font-bold font-mono text-emerald-400 truncate">
                        {{ formatBytesPerSecond(currentServerStatus.netRxRate) }}
                      </span>
                    </div>
                  </div>

                  <!-- 上行 (上传) -->
                  <div class="flex items-center gap-2.5 p-2 rounded-lg bg-background/60 border border-border/40">
                    <div class="w-7 h-7 rounded-lg bg-orange-500/10 text-orange-400 flex items-center justify-center shrink-0">
                      <i class="fas fa-arrow-up text-xs"></i>
                    </div>
                    <div class="flex flex-col min-w-0">
                      <span class="text-[10px] text-text-secondary/80">上传速率</span>
                      <span class="text-xs font-bold font-mono text-orange-400 truncate">
                        {{ formatBytesPerSecond(currentServerStatus.netTxRate) }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 历史走势趋势折线图 -->
              <StatusCharts
                v-if="activeSessionId && currentServerStatus"
                :server-status="currentServerStatus"
                :active-session-id="activeSessionId"
              />
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
