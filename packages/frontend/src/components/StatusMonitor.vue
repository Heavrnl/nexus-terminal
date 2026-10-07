<template>
  <!-- 根元素：桌面端服务器状态监控仪表盘 -->
  <div
    class="status-monitor p-4 bg-background text-foreground h-full overflow-y-auto text-sm transition-colors duration-200"
    :class="{ 'bg-header/20': !activeSessionId }"
  >
    <!-- 顶栏：标题、实时监控指示灯与会话快捷信息 -->
    <div v-if="activeSessionId" class="flex items-center justify-between border-b border-border/60 pb-3 mb-3.5 flex-wrap gap-2">
      <div class="flex items-center gap-2.5">
        <div class="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shadow-2xs">
          <i class="fas fa-gauge-high text-sm"></i>
        </div>
        <div>
          <h4 class="m-0 text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
            <span>{{ t('statusMonitor.title', '状态监视器') }}</span>
          </h4>
        </div>
      </div>

      <!-- 右侧：当前主机名称或 IP 快捷复制胶囊 -->
      <div class="flex items-center gap-1.5">
        <button
          v-if="statusMonitorShowIpBoolean && sessionIpAddress"
          type="button"
          @click="copyIpToClipboard(sessionIpAddress)"
          class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-header/60 hover:bg-header border border-border/60 text-xs font-mono text-text-secondary hover:text-primary active:scale-95 transition-all cursor-pointer shadow-2xs"
          :title="t('statusMonitor.copyIpHint', '点击复制 IP')"
        >
          <i class="fas fa-network-wired text-[11px] text-text-secondary"></i>
          <span class="truncate max-w-[140px]">{{ sessionIpAddress }}</span>
          <i class="fas fa-copy text-[10px] opacity-70"></i>
        </button>
      </div>
    </div>

    <!-- Case 1: 无活动会话状态 -->
    <div
      v-if="!activeSessionId"
      class="no-session-status flex flex-col items-center justify-center text-center text-text-secondary py-16 h-[80%] space-y-3"
    >
      <div class="w-16 h-16 rounded-2xl bg-header/50 border border-border/60 flex items-center justify-center text-text-secondary/60 shadow-xs">
        <i class="fas fa-plug text-2xl"></i>
      </div>
      <div class="space-y-1">
        <h5 class="text-sm font-semibold text-foreground m-0">{{ t('layout.noActiveSession.title', '暂无活动会话') }}</h5>
        <p class="text-xs text-text-secondary m-0 max-w-xs leading-relaxed">
          {{ t('statusMonitor.noSessionDesc', '请在左侧或上方建立/切换到一个 SSH 会话以实时监控该主机的性能。') }}
        </p>
      </div>
    </div>

    <!-- Case 2: 错误状态 -->
    <div
      v-else-if="currentStatusError"
      class="status-error flex flex-col items-center justify-center text-center text-rose-500 py-12 h-[80%] space-y-2.5 p-4 rounded-xl bg-rose-500/5 border border-rose-500/20"
    >
      <div class="w-12 h-12 rounded-xl bg-rose-500/10 flex items-center justify-center text-rose-400">
        <i class="fas fa-triangle-exclamation text-xl"></i>
      </div>
      <span class="text-sm font-medium">{{ t('statusMonitor.errorPrefix', '监控数据异常:') }}</span>
      <span class="text-xs font-mono text-text-secondary break-all max-w-md">{{ currentStatusError }}</span>
    </div>

    <!-- Case 3: 加载中状态 -->
    <div
      v-else-if="!currentServerStatus"
      class="loading-status flex flex-col items-center justify-center text-center text-text-secondary py-16 h-[80%] space-y-3"
    >
      <i class="fas fa-circle-notch fa-spin text-3xl text-primary"></i>
      <span class="text-xs font-medium">{{ t('statusMonitor.loading', '正在采集服务器指标...') }}</span>
    </div>

    <!-- Case 4: 正常数据监控面板 -->
    <div v-else class="space-y-3">
      <!-- 1. 主机与系统硬件规格概览卡片 -->
      <div class="rounded-xl bg-header/35 border border-border/60 p-3 space-y-2 shadow-2xs hover:border-border/80 transition-all">
        <div class="flex items-center justify-between text-xs pb-1.5 border-b border-border/40">
          <div class="flex items-center gap-2 min-w-0">
            <i class="fas fa-server text-primary text-xs shrink-0"></i>
            <span class="text-sm font-bold text-foreground truncate" :title="sessionConnectionName || '当前主机'">
              {{ sessionConnectionName || '当前主机' }}
            </span>
          </div>
          <span class="text-xs font-mono text-text-secondary/80 shrink-0">
            {{ currentServerStatus?.netInterface || 'Linux' }}
          </span>
        </div>

        <div class="grid grid-cols-1 gap-2 text-xs pt-0.5">
          <!-- 操作系统 -->
          <div class="flex items-start gap-2">
            <span class="shrink-0 text-text-secondary flex items-center gap-1.5 min-w-[54px] font-medium">
              <i class="fab fa-linux text-xs text-text-secondary"></i>
              <span>{{ t('statusMonitor.osLabel', '系统:') }}</span>
            </span>
            <span class="text-xs font-medium text-foreground break-words flex-1 leading-snug" :title="displayOsName">
              {{ displayOsName }}
            </span>
          </div>

          <!-- CPU 型号 -->
          <div class="flex items-start gap-2">
            <span class="shrink-0 text-text-secondary flex items-center gap-1.5 min-w-[54px] font-medium">
              <i class="fas fa-microchip text-xs text-sky-400"></i>
              <span>{{ t('statusMonitor.cpuModelLabel', 'CPU:') }}</span>
            </span>
            <span class="font-mono text-xs text-foreground/90 break-words flex-1 leading-snug" :title="displayCpuModel">
              {{ displayCpuModel }}
            </span>
          </div>
        </div>
      </div>

      <!-- 2. 四大核心资源指标卡片 (紧凑 2x2 双列网格，字号适度饱满清晰) -->
      <div class="grid grid-cols-2 gap-2">
        <!-- CPU 使用率卡片 -->
        <div class="metric-card rounded-xl bg-header/25 border border-border/50 hover:border-border p-2.5 flex flex-col justify-between space-y-2 shadow-2xs transition-all">
          <div class="flex items-center justify-between gap-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <i class="fas fa-microchip text-xs text-sky-400 shrink-0"></i>
              <span class="text-xs font-bold text-text-secondary truncate">{{ t('statusMonitor.cpuLabel', 'CPU') }}</span>
            </div>
            <span class="text-sm font-bold font-mono tracking-tight text-foreground shrink-0">
              {{ Math.round(displayCpuPercent) }}%
            </span>
          </div>

          <!-- 饱满进度条 -->
          <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden relative">
            <div
              class="h-full rounded-full transition-all duration-300 ease-out"
              :style="{ width: `${Math.min(100, Math.max(0, displayCpuPercent))}%` }"
              :class="getProgressGradient(displayCpuPercent)"
            ></div>
          </div>

          <!-- 底部占用率独占一行 -->
          <div class="text-xs font-mono text-text-secondary/80 truncate text-right">
            利用率 {{ (displayCpuPercent).toFixed(1) }}%
          </div>
        </div>

        <!-- 内存使用率卡片 -->
        <div class="metric-card rounded-xl bg-header/25 border border-border/50 hover:border-border p-2.5 flex flex-col justify-between space-y-2 shadow-2xs transition-all">
          <div class="flex items-center justify-between gap-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <i class="fas fa-memory text-xs text-emerald-400 shrink-0"></i>
              <span class="text-xs font-bold text-text-secondary truncate">{{ t('statusMonitor.memoryLabel', '内存') }}</span>
            </div>
            <span class="text-sm font-bold font-mono tracking-tight text-foreground shrink-0">
              {{ Math.round(displayMemPercent) }}%
            </span>
          </div>

          <!-- 饱满进度条 -->
          <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden relative">
            <div
              class="h-full rounded-full transition-all duration-300 ease-out"
              :style="{ width: `${Math.min(100, Math.max(0, displayMemPercent))}%` }"
              :class="getProgressGradient(displayMemPercent)"
            ></div>
          </div>

          <!-- 底部详情：独占一行位于进度条下方，绝不与百分比挤压 -->
          <div class="text-xs font-mono text-text-secondary/85 truncate text-right" :title="memDisplay">
            {{ memDisplay }}
          </div>
        </div>

        <!-- Swap 交换分区卡片 -->
        <div class="metric-card rounded-xl bg-header/25 border border-border/50 hover:border-border p-2.5 flex flex-col justify-between space-y-2 shadow-2xs transition-all">
          <div class="flex items-center justify-between gap-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <i class="fas fa-right-left text-xs text-amber-400 shrink-0"></i>
              <span class="text-xs font-bold text-text-secondary truncate">{{ t('statusMonitor.swapLabel', 'Swap') }}</span>
            </div>
            <span class="text-sm font-bold font-mono tracking-tight text-foreground shrink-0">
              {{ Math.round(displaySwapPercent) }}%
            </span>
          </div>

          <!-- 饱满进度条 -->
          <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden relative">
            <div
              class="h-full rounded-full transition-all duration-300 ease-out"
              :style="{ width: `${Math.min(100, Math.max(0, displaySwapPercent))}%` }"
              :class="getProgressGradient(displaySwapPercent)"
            ></div>
          </div>

          <!-- 底部详情 -->
          <div class="text-xs font-mono text-text-secondary/85 truncate text-right" :title="swapDisplay">
            {{ swapDisplay }}
          </div>
        </div>

        <!-- 磁盘使用率卡片 -->
        <div class="metric-card rounded-xl bg-header/25 border border-border/50 hover:border-border p-2.5 flex flex-col justify-between space-y-2 shadow-2xs transition-all">
          <div class="flex items-center justify-between gap-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <i class="fas fa-hard-drive text-xs text-purple-400 shrink-0"></i>
              <span class="text-xs font-bold text-text-secondary truncate">{{ t('statusMonitor.diskLabel', '磁盘') }}</span>
            </div>
            <span class="text-sm font-bold font-mono tracking-tight text-foreground shrink-0">
              {{ Math.round(displayDiskPercent) }}%
            </span>
          </div>

          <!-- 饱满进度条 -->
          <div class="w-full h-2 rounded-full bg-border/40 overflow-hidden relative">
            <div
              class="h-full rounded-full transition-all duration-300 ease-out"
              :style="{ width: `${Math.min(100, Math.max(0, displayDiskPercent))}%` }"
              :class="getProgressGradient(displayDiskPercent)"
            ></div>
          </div>

          <!-- 底部详情 -->
          <div class="text-xs font-mono text-text-secondary/85 truncate text-right" :title="diskDisplay">
            {{ diskDisplay }}
          </div>
        </div>
      </div>

      <!-- 3. 实时网络流量卡片 -->
      <div class="rounded-xl bg-header/25 border border-border/50 hover:border-border/70 p-2.5 space-y-2 shadow-2xs transition-all">
        <div class="flex items-center justify-between text-xs">
          <div class="flex items-center gap-1.5 font-bold text-text-secondary">
            <i class="fas fa-network-wired text-primary text-xs"></i>
            <span>{{ t('statusMonitor.networkLabel', '实时网络流量') }}</span>
          </div>
          <span class="text-xs font-mono px-1.5 py-0.5 rounded bg-background border border-border/60 text-text-secondary/80">
            {{ currentServerStatus?.netInterface || 'default' }}
          </span>
        </div>

        <!-- 双胶囊速率展示 (字号与上方卡片严格协调统一) -->
        <div class="grid grid-cols-2 gap-2 pt-0.5">
          <!-- 下行速率 -->
          <div class="flex items-center justify-between p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <div class="flex items-center gap-1.5 text-xs font-medium shrink-0">
              <i class="fas fa-arrow-down text-[11px]"></i>
              <span>下载</span>
            </div>
            <span class="font-mono text-xs font-bold truncate">
              {{ formatBytesPerSecond(currentServerStatus?.netRxRate) }}
            </span>
          </div>

          <!-- 上行速率 -->
          <div class="flex items-center justify-between p-2 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400">
            <div class="flex items-center gap-1.5 text-xs font-medium shrink-0">
              <i class="fas fa-arrow-up text-[11px]"></i>
              <span>上传</span>
            </div>
            <span class="font-mono text-xs font-bold truncate">
              {{ formatBytesPerSecond(currentServerStatus?.netTxRate) }}
            </span>
          </div>
        </div>
      </div>

      <!-- 4. 原生图表组件 (保持原有图表不变) -->
      <StatusCharts
        v-if="activeSessionId && currentServerStatus"
        :server-status="currentServerStatus"
        :active-session-id="activeSessionId"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import StatusCharts from './StatusCharts.vue';
import { useSessionStore } from '../stores/session.store';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '../stores/settings.store';
import { useConnectionsStore } from '../stores/connections.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';

const { t } = useI18n();
const sessionStore = useSessionStore();
const settingsStore = useSettingsStore();
const connectionsStore = useConnectionsStore();
const uiNotificationsStore = useUiNotificationsStore();

const { sessions } = storeToRefs(sessionStore);
const { statusMonitorShowIpBoolean } = storeToRefs(settingsStore);

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

// --- Props ---
const props = defineProps({
  activeSessionId: {
    type: String as PropType<string | null>,
    required: false,
    default: null,
  },
});

// --- 会话与状态计算属性 ---
const currentSessionState = computed(() => {
  return props.activeSessionId ? sessions.value.get(props.activeSessionId) : null;
});

const currentServerStatus = computed<ServerStatus | null>(() => {
  return currentSessionState.value?.statusMonitorManager?.serverStatus?.value ?? null;
});

const currentStatusError = computed<string | null>(() => {
  return currentSessionState.value?.statusMonitorManager?.statusError?.value ?? null;
});

// 计算当前会话关联的连接配置
const currentConnectionInfo = computed(() => {
  const sessionState = currentSessionState.value;
  if (!sessionState || !sessionState.connectionId) return null;
  const connectionIdAsNumber = parseInt(sessionState.connectionId, 10);
  if (isNaN(connectionIdAsNumber)) return null;
  return connectionsStore.connections.find(conn => conn.id === connectionIdAsNumber) || null;
});

// 主机友好名称
const sessionConnectionName = computed(() => {
  return currentConnectionInfo.value?.name || (props.activeSessionId ? `会话 ${props.activeSessionId}` : null);
});

// IP 地址
const sessionIpAddress = computed(() => {
  return currentConnectionInfo.value?.host || null;
});

// 复制 IP 地址
const copyIpToClipboard = async (ipAddress: string | null) => {
  if (!ipAddress) return;
  try {
    await navigator.clipboard.writeText(ipAddress);
    uiNotificationsStore.showSuccess(t('common.copied', '已复制!'));
  } catch (err) {
    console.error('Failed to copy IP address: ', err);
    uiNotificationsStore.showError(t('statusMonitor.copyIpError', '复制 IP 失败'));
  }
};

// 资源使用率数值计算
const displayCpuPercent = computed(() => currentServerStatus.value?.cpuPercent ?? 0);
const displayMemPercent = computed(() => currentServerStatus.value?.memPercent ?? 0);
const displaySwapPercent = computed(() => currentServerStatus.value?.swapPercent ?? 0);
const displayDiskPercent = computed(() => currentServerStatus.value?.diskPercent ?? 0);

// 缓存硬件与系统信息
const cachedCpuModel = ref<string | null>(null);
const cachedOsName = ref<string | null>(null);

watch(currentServerStatus, (newData) => {
  if (newData) {
    if (newData.cpuModel && newData.cpuModel !== '') {
      cachedCpuModel.value = newData.cpuModel;
    }
    if (newData.osName && newData.osName !== '') {
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
const formatBytesPerSecond = (bytes?: number): string => {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return t('statusMonitor.notAvailable', '0 B/s');
  if (bytes < 1024) return `${bytes} ${t('statusMonitor.bytesPerSecond', 'B/s')}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('statusMonitor.kiloBytesPerSecond', 'KB/s')}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('statusMonitor.megaBytesPerSecond', 'MB/s')}`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ${t('statusMonitor.gigaBytesPerSecond', 'GB/s')}`;
};

// 格式化 KB 为 GB
const formatKbToGb = (kb?: number): string => {
  if (kb === undefined || kb === null) return t('statusMonitor.notAvailable', '0.0 GB');
  if (kb === 0) return `0.0 ${t('statusMonitor.gigaBytes', 'GB')}`;
  const gb = kb / 1024 / 1024;
  return `${gb.toFixed(1)} ${t('statusMonitor.gigaBytes', 'GB')}`;
};

// 格式化 MB 为 GB / MB
const formatMemorySize = (mb?: number): string => {
  if (mb === undefined || mb === null || isNaN(mb)) return t('statusMonitor.notAvailable', '0 MB');
  if (mb < 1024) {
    const value = Number.isInteger(mb) ? mb : mb.toFixed(1);
    return `${value} ${t('statusMonitor.megaBytes', 'MB')}`;
  } else {
    const gb = mb / 1024;
    return `${gb.toFixed(1)} ${t('statusMonitor.gigaBytes', 'GB')}`;
  }
};

const memDisplay = computed(() => {
  const data = currentServerStatus.value;
  if (!data || data.memUsed === undefined || data.memTotal === undefined) return t('statusMonitor.notAvailable', '0 / 0');
  return `${formatMemorySize(data.memUsed)} / ${formatMemorySize(data.memTotal)}`;
});

const diskDisplay = computed(() => {
  const data = currentServerStatus.value;
  if (!data || data.diskUsed === undefined || data.diskTotal === undefined) return t('statusMonitor.notAvailable', '0 / 0');
  return `${formatKbToGb(data.diskUsed)} / ${formatKbToGb(data.diskTotal)}`;
});

const swapDisplay = computed(() => {
  const data = currentServerStatus.value;
  const used = data?.swapUsed ?? 0;
  const total = data?.swapTotal ?? 0;
  if (total === 0) {
    return t('statusMonitor.swapNotAvailable', '未启用 Swap');
  }
  return `${formatMemorySize(used)} / ${formatMemorySize(total)}`;
});

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
</script>

<style scoped>
.metric-card {
  backdrop-filter: blur(4px);
}
</style>
