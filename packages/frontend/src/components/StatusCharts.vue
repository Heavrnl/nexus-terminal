<template>
  <div class="status-charts grid grid-cols-1 gap-2.5 mt-2.5">
    <!-- 1. CPU 历史趋势卡片 -->
    <div class="chart-container rounded-xl bg-header/25 border border-border/50 hover:border-border/70 p-3 shadow-2xs transition-all flex flex-col space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 min-w-0">
          <i class="fas fa-chart-line text-xs text-sky-400 shrink-0"></i>
          <span class="text-xs font-semibold text-text-secondary truncate">
            {{ t('statusMonitor.cpuUsageTitle', 'CPU 使用率') }}
          </span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <span class="font-mono text-xs font-bold text-foreground">
            {{ latestCpuVal }}%
          </span>
        </div>
      </div>
      <div class="chart-wrapper h-36 w-full">
        <Line :data="cpuChartData" :options="percentageChartOptions" :key="cpuChartKey" />
      </div>
    </div>

    <!-- 2. 网络速率走势卡片 -->
    <div class="chart-container rounded-xl bg-header/25 border border-border/50 hover:border-border/70 p-3 shadow-2xs transition-all flex flex-col space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 min-w-0">
          <i class="fas fa-chart-area text-xs text-primary shrink-0"></i>
          <span class="text-xs font-semibold text-text-secondary truncate">
            {{ t('statusMonitor.networkSpeedTitleUnit', { unit: networkRateUnitIsMB ? 'MB/s' : 'KB/s' }) }}
          </span>
        </div>
        <!-- 图例与最新数值 -->
        <div class="flex items-center gap-2.5 text-[11px] font-mono shrink-0">
          <div class="flex items-center gap-1 text-emerald-400" :title="t('statusMonitor.networkDownloadLabelUnit', { unit: networkRateUnitIsMB ? 'MB/s' : 'KB/s' })">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
            <span class="text-text-secondary/60">↓</span>
            <span class="font-bold">{{ latestRxVal }}</span>
          </div>
          <div class="flex items-center gap-1 text-orange-400" :title="t('statusMonitor.networkUploadLabelUnit', { unit: networkRateUnitIsMB ? 'MB/s' : 'KB/s' })">
            <span class="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0"></span>
            <span class="text-text-secondary/60">↑</span>
            <span class="font-bold">{{ latestTxVal }}</span>
          </div>
        </div>
      </div>
      <div class="chart-wrapper h-36 w-full">
        <Line :data="networkChartData" :options="networkChartOptions" :key="networkChartKey" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, computed, type PropType } from 'vue'; 
import { useI18n } from 'vue-i18n';
import { Line } from 'vue-chartjs';
import { useSessionStore } from '../stores/session.store'; 
import { storeToRefs } from 'pinia'; 
import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  CategoryScale,
  Filler,
  ChartOptions,
  TooltipItem,
} from 'chart.js';

ChartJS.register(
  Title,
  Tooltip,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  CategoryScale,
  Filler
);

// Define a more specific type for serverStatus if possible, or use as is if memUsed/memTotal are reliably present.
// For now, assuming props.serverStatus will have memUsed and memTotal in MB.
interface ServerStatusData {
  cpuPercent?: number;
  memPercent?: number; // Will be ignored for chart data, but kept for other potential uses
  memUsed?: number;    // in MB
  memTotal?: number;   // in MB
  netRxRate?: number;  // in Bytes/sec
  netTxRate?: number;  // in Bytes/sec
  // ... other properties if needed
}

const props = defineProps({
  serverStatus: { // Keep serverStatus for current values and Y-axis scaling logic
      type: Object as PropType<ServerStatusData | null>,
      required: true,
  },
  activeSessionId: {
    type: String as PropType<string | null>,
    required: true,
  },
});

const MAX_DATA_POINTS = 60;
const KB_TO_MB_THRESHOLD = 1024; // For network
const MB_TO_GB_THRESHOLD = 1024; // For memory

const { t } = useI18n();
const sessionStore = useSessionStore();
const { sessions } = storeToRefs(sessionStore); // 获取响应式的 sessions

const cpuChartKey = ref(0);
const memoryChartKey = ref(0);
const networkChartKey = ref(0);

const networkRateUnitIsMB = ref(false);
const memoryUnitIsGB = ref(false);

// const networkChartTitle = ref('网络速度 (KB/s)'); // Will be replaced by i18n
// const memoryChartTitle = ref('内存使用情况 (MB)'); // Will be replaced by i18n


const initialLabels = Array.from({ length: MAX_DATA_POINTS }, () => '');

// --- 计算属性：从 Store 获取当前会话的历史数据 ---
const currentSessionStatusManager = computed(() => {
  return props.activeSessionId ? sessions.value.get(props.activeSessionId)?.statusMonitorManager : null;
});

const currentCpuHistory = computed(() => {
  return currentSessionStatusManager.value?.cpuHistory.value ?? Array(MAX_DATA_POINTS).fill(null);
});

const currentMemUsedHistory = computed(() => {
    // 返回 MB 为单位的历史数据
  return currentSessionStatusManager.value?.memUsedHistory.value ?? Array(MAX_DATA_POINTS).fill(null);
});

const currentNetRxHistory = computed(() => {
    // 返回 Bytes/sec 为单位的历史数据
  return currentSessionStatusManager.value?.netRxHistory.value ?? Array(MAX_DATA_POINTS).fill(null);
});

const currentNetTxHistory = computed(() => {
    // 返回 Bytes/sec 为单位的历史数据
  return currentSessionStatusManager.value?.netTxHistory.value ?? Array(MAX_DATA_POINTS).fill(null);
});


// --- 计算最新数值展示 ---
const latestCpuVal = computed(() => {
  const data = cpuChartData.value.datasets[0]?.data;
  const v = data?.[MAX_DATA_POINTS - 1];
  if (v !== undefined && v !== null && !isNaN(v)) {
    return v.toFixed(1);
  }
  return (props.serverStatus?.cpuPercent ?? 0).toFixed(1);
});

const latestRxVal = computed(() => {
  const data = networkChartData.value.datasets[0]?.data;
  const v = data?.[MAX_DATA_POINTS - 1];
  const precision = networkRateUnitIsMB.value ? 2 : 1;
  if (v !== undefined && v !== null && !isNaN(v)) {
    return v.toFixed(precision);
  }
  return '0.0';
});

const latestTxVal = computed(() => {
  const data = networkChartData.value.datasets[1]?.data;
  const v = data?.[MAX_DATA_POINTS - 1];
  const precision = networkRateUnitIsMB.value ? 2 : 1;
  if (v !== undefined && v !== null && !isNaN(v)) {
    return v.toFixed(precision);
  }
  return '0.0';
});

// --- 图表数据结构，现在 data 指向 computed 属性 ---
const cpuChartData = computed(() => ({
  labels: initialLabels, // 标签保持不变
  datasets: [
    {
      label: t('statusMonitor.cpuUsageLabel', 'CPU 使用率 (%)'),
      backgroundColor: 'rgba(56, 189, 248, 0.12)',
      borderColor: '#38bdf8',
      borderWidth: 1.5,
      fill: true,
      data: currentCpuHistory.value.map(v => v ?? 0), // 将 null 映射为 0 用于图表
      tension: 0.25,
      pointRadius: 0,
      pointHoverRadius: 4,
    },
  ],
}));

// 动态计算内存图表数据（转换单位）
const memoryChartData = computed(() => {
    const historyMB = currentMemUsedHistory.value;
    let displayData: (number | null)[];

    // 检查是否需要转换为 GB (基于当前值或历史峰值)
    const currentTotalMB = props.serverStatus?.memTotal ?? 0;
    const historyPeakMB = Math.max(...historyMB.filter((v): v is number => v !== null), 0);
    const requiresGB = currentTotalMB >= MB_TO_GB_THRESHOLD || historyPeakMB >= MB_TO_GB_THRESHOLD;
    memoryUnitIsGB.value = requiresGB; // 更新单位标志

    if (requiresGB) {
        displayData = historyMB.map(mb => mb === null ? null : parseFloat((mb / MB_TO_GB_THRESHOLD).toFixed(1)));
    } else {
        displayData = historyMB.map(mb => mb === null ? null : parseFloat(mb.toFixed(1)));
    }

    return {
        labels: initialLabels,
        datasets: [
            {
                label: t('statusMonitor.memoryUsageLabelUnit', { unit: requiresGB ? 'GB' : 'MB' }),
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                borderColor: 'rgba(255, 99, 132, 1)',
                borderWidth: 1,
                data: displayData.map(v => v ?? 0), // 将 null 映射为 0
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 5,
            },
        ],
    };
});


// 动态计算网络图表数据（转换单位）
const networkChartData = computed(() => {
    const historyRxBps = currentNetRxHistory.value;
    const historyTxBps = currentNetTxHistory.value;
    let displayRxData: (number | null)[];
    let displayTxData: (number | null)[];

    // 检查是否需要转换为 MB/s (基于当前值或历史峰值)
    const currentRxKB = (props.serverStatus?.netRxRate ?? 0) / 1024;
    const currentTxKB = (props.serverStatus?.netTxRate ?? 0) / 1024;
    const historyPeakRxKB = Math.max(...historyRxBps.filter((v): v is number => v !== null).map(bps => bps / 1024), 0);
    const historyPeakTxKB = Math.max(...historyTxBps.filter((v): v is number => v !== null).map(bps => bps / 1024), 0);
    const requiresMB = currentRxKB >= KB_TO_MB_THRESHOLD || currentTxKB >= KB_TO_MB_THRESHOLD ||
                       historyPeakRxKB >= KB_TO_MB_THRESHOLD || historyPeakTxKB >= KB_TO_MB_THRESHOLD;
    networkRateUnitIsMB.value = requiresMB; // 更新单位标志

    const divisor = requiresMB ? (1024 * 1024) : 1024;
    const precision = requiresMB ? 2 : 1;

    displayRxData = historyRxBps.map(bps => bps === null ? null : parseFloat((bps / divisor).toFixed(precision)));
    displayTxData = historyTxBps.map(bps => bps === null ? null : parseFloat((bps / divisor).toFixed(precision)));

    return {
        labels: initialLabels,
        datasets: [
            {
                label: t('statusMonitor.networkDownloadLabelUnit', { unit: requiresMB ? 'MB/s' : 'KB/s' }),
                backgroundColor: 'rgba(16, 185, 129, 0.12)',
                borderColor: '#10b981',
                borderWidth: 1.5,
                fill: true,
                data: displayRxData.map(v => v ?? 0), // 将 null 映射为 0
                tension: 0.25,
                pointRadius: 0,
                pointHoverRadius: 4,
            },
            {
                label: t('statusMonitor.networkUploadLabelUnit', { unit: requiresMB ? 'MB/s' : 'KB/s' }),
                backgroundColor: 'rgba(249, 115, 22, 0.12)',
                borderColor: '#f97316',
                borderWidth: 1.5,
                fill: true,
                data: displayTxData.map(v => v ?? 0), // 将 null 映射为 0
                tension: 0.25,
                pointRadius: 0,
                pointHoverRadius: 4,
            },
        ],
    };
});

const baseChartOptions: Omit<ChartOptions<'line'>, 'scales'> = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      enabled: true,
      mode: 'index',
      intersect: false,
      backgroundColor: 'rgba(15, 23, 42, 0.92)',
      titleColor: '#e2e8f0',
      bodyColor: '#cbd5e1',
      borderColor: 'rgba(255, 255, 255, 0.1)',
      borderWidth: 1,
      padding: 8,
      boxPadding: 4,
      titleFont: { size: 11, family: 'ui-monospace, monospace' },
      bodyFont: { size: 11, family: 'ui-monospace, monospace' },
      cornerRadius: 6,
    },
  },
  interaction: { mode: 'index', intersect: false },
};

const percentageChartOptions = ref<ChartOptions<'line'>>({ // For CPU
  ...baseChartOptions,
  scales: {
    y: {
      beginAtZero: true,
      min: 0,
      max: 100,
      ticks: {
        color: 'rgba(156, 163, 175, 0.7)',
        font: { size: 10, family: 'ui-monospace, monospace' },
        callback: value => `${value}%`,
        maxTicksLimit: 5,
      },
      grid: { color: 'rgba(255, 255, 255, 0.05)' },
      border: { display: false },
    },
    x: {
      ticks: { display: false },
      grid: { display: false },
      border: { display: false },
    },
  },
});

const memoryChartOptions = ref<ChartOptions<'line'>>({
  ...baseChartOptions,
  plugins: {
    ...baseChartOptions.plugins,
    tooltip: {
      ...baseChartOptions.plugins?.tooltip,
      callbacks: {
        label: (context: TooltipItem<'line'>) => {
          let label = context.dataset.label || '';
          if (label) {
            label = label.substring(0, label.lastIndexOf('(') -1); // Remove old unit from label
            label += ': ';
          }
          if (context.parsed.y !== null) {
            const value = parseFloat(context.parsed.y.toFixed(1));
            label += `${value} ${memoryUnitIsGB.value ? 'GB' : 'MB'}`;
          }
          return label;
        },
      },
    },
  },
  scales: {
    y: {
      beginAtZero: true,
      min: 0,
      // max will be set dynamically based on memTotal
      ticks: {
        color: 'rgba(156, 163, 175, 0.7)',
        font: { size: 10, family: 'ui-monospace, monospace' },
        callback: function(value) {
          return `${parseFloat(Number(value).toFixed(1))}`; // Unit will be implicit from title or tooltip
        }
      },
      grid: { color: 'rgba(255, 255, 255, 0.05)' },
      border: { display: false },
    },
    x: {
      ticks: { display: false },
      grid: { display: false },
      border: { display: false },
    },
  },
});

const networkChartOptions = ref<ChartOptions<'line'>>({
  ...baseChartOptions,
  plugins: {
    ...baseChartOptions.plugins,
    tooltip: {
      ...baseChartOptions.plugins?.tooltip,
      callbacks: {
        label: (context: TooltipItem<'line'>) => {
          let label = context.dataset.label || '';
           if (label) {
            label = label.substring(0, label.lastIndexOf('(') -1); // Remove old unit from label
            label += ': ';
          }
          if (context.parsed.y !== null) {
            const precision = networkRateUnitIsMB.value ? 2 : 1;
            const value = parseFloat(context.parsed.y.toFixed(precision));
            label += `${value} ${networkRateUnitIsMB.value ? 'MB/s' : 'KB/s'}`;
          }
          return label;
        },
      },
    },
  },
  scales: {
    y: {
      beginAtZero: true,
      min: 0,
      max: 10, // 初始值，将动态更新
      ticks: {
        color: 'rgba(156, 163, 175, 0.7)',
        font: { size: 10, family: 'ui-monospace, monospace' },
        maxTicksLimit: 5,
        callback: function(value) {
          const precision = networkRateUnitIsMB.value ? 2 : 0; // KB/s usually whole numbers, MB/s two decimal places
          if (!networkRateUnitIsMB.value && Number(value) !== parseInt(String(value)) && Number(value) < 100) {
            return `${Number(value).toFixed(1)}`;
          }
          return `${Number(value).toFixed(precision)}`;
        }
      },
      grid: { color: 'rgba(255, 255, 255, 0.05)' },
      border: { display: false },
    },
    x: {
      ticks: { display: false },
      grid: { display: false },
      border: { display: false },
    },
  },
});


// --- 函数：动态更新 Y 轴范围和单位（基于当前 serverStatus 和 store 中的历史数据） ---
const updateAxisAndUnits = () => {
  // 内存 Y 轴和单位
  if (props.serverStatus && memoryChartOptions.value.scales?.y) {
      const historyMB = currentMemUsedHistory.value;
      const memTotal = props.serverStatus.memTotal ?? 0;
      const requiresGB = memoryUnitIsGB.value; // memoryChartData computed prop already sets this

      let yAxisTopValue = requiresGB
          ? parseFloat((memTotal / MB_TO_GB_THRESHOLD).toFixed(1))
          : parseFloat(memTotal.toFixed(1));

      const currentMaxDataPoint = Math.max(...historyMB.filter((v): v is number => v !== null).map(mb => requiresGB ? mb / MB_TO_GB_THRESHOLD : mb), 0);
      yAxisTopValue = Math.max(yAxisTopValue, currentMaxDataPoint);

      if (yAxisTopValue === 0) {
          yAxisTopValue = requiresGB ? 1 : 100;
      } else {
          const epsilon = requiresGB ? 0.01 : 1;
          yAxisTopValue += epsilon;
          yAxisTopValue = requiresGB ? Math.ceil(yAxisTopValue * 100) / 100 : Math.ceil(yAxisTopValue);
      }

      if (memoryChartOptions.value.scales.y.max !== yAxisTopValue) {
        memoryChartOptions.value.scales.y.max = yAxisTopValue;
        memoryChartKey.value++; // 强制重绘以应用新的 max
      }
  }

  // 网络 Y 轴和单位
  if (props.serverStatus && networkChartOptions.value.scales?.y) {
      const historyRxBps = currentNetRxHistory.value;
      const historyTxBps = currentNetTxHistory.value;
      const requiresMB = networkRateUnitIsMB.value; // networkChartData computed prop already sets this
      const divisor = requiresMB ? (1024 * 1024) : 1024;

      const allNetworkData = [
          ...historyRxBps.filter((v): v is number => v !== null).map(bps => bps / divisor),
          ...historyTxBps.filter((v): v is number => v !== null).map(bps => bps / divisor)
      ];
      const currentMaxDataPoint = Math.max(...allNetworkData, 0);

      let suggestedMax;
      const baseMultiplier = 1.2;
      if (currentMaxDataPoint === 0) {
          suggestedMax = requiresMB ? 5 : 500;
      } else {
          suggestedMax = currentMaxDataPoint * baseMultiplier;
      }

      const absoluteMinMax = requiresMB ? 1 : 100;
      suggestedMax = Math.max(suggestedMax, absoluteMinMax);

      if (requiresMB) {
          suggestedMax = Math.ceil(suggestedMax);
      } else {
          if (suggestedMax <= 100) {
              suggestedMax = Math.ceil(suggestedMax / 10) * 10;
              if (suggestedMax === 0 && currentMaxDataPoint > 0) suggestedMax = 10;
          } else if (suggestedMax <= 500) {
              suggestedMax = Math.ceil(suggestedMax / 50) * 50;
          } else {
              suggestedMax = Math.ceil(suggestedMax / 100) * 100;
          }
      }

      if (currentMaxDataPoint > 0 && suggestedMax === 0) {
          suggestedMax = requiresMB ? 1 : (allNetworkData.some(d => d > 0 && d < 10 / divisor) ? 10 : 100);
      }
      if (currentMaxDataPoint === 0 && suggestedMax === 0) {
          suggestedMax = requiresMB ? 1 : 100;
      }

       if (networkChartOptions.value.scales.y.max !== suggestedMax) {
           networkChartOptions.value.scales.y.max = suggestedMax;
           networkChartKey.value++; // 强制重绘以应用新的 max
       }
  }
};

// --- 监听 props.serverStatus 的变化，仅用于更新 Y 轴范围和单位 ---
// 数据本身由 computed 属性从 store 获取
watch(() => props.serverStatus, () => {
    updateAxisAndUnits();
}, { deep: true, immediate: true }); // immediate: true 确保初始加载时设置好轴

// 移除监听 activeSessionId 的 watcher 和 resetChartData 函数

onMounted(() => {
  // 初始轴和单位设置由 watch immediate 处理
});

</script>

<style scoped>
.chart-container {
  backdrop-filter: blur(4px);
}
</style>