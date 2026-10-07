
<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../utils/apiClient';
import { useConnectionsStore } from '../stores/connections.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';

interface Props {
  visible: boolean;
  isMobile?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isMobile: undefined,
});
const emit = defineEmits(['update:visible']);
const { t, locale } = useI18n();
const connectionsStore = useConnectionsStore();
const { isMobile: detectedMobile } = useDeviceDetection();

// 视口尺寸响应式监听
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
const handleResize = () => {
  windowWidth.value = window.innerWidth;
};

onMounted(() => {
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
});

const isMobileMode = computed(() => {
  if (typeof props.isMobile === 'boolean') {
    return props.isMobile;
  }
  return detectedMobile.value || windowWidth.value < 768;
});

// Helper function to get connection name by ID
// 注意: 此函数假设 'connectionsStore.connections' 是一个包含连接对象的数组，
// 每个对象至少有 'id' 和 'name' 属性。请根据实际 store 结构调整。
const getConnectionName = (connectionId: number): string => {
  const connection = connectionsStore.connections?.find((c: any) => c.id === connectionId);
  if (connection && connection.name) {
    return connection.name;
  }
  return `连接ID: ${connectionId}`; // 未找到连接或名称时的回退显示
};

// Helper function to format the task title
const formatTaskTitle = (task: TransferTask): string => {
  const fileName = (task.subTasks && task.subTasks.length > 0)
    ? task.subTasks[0].sourceItemName
    : "[文件名未知]";
  
  const sourceServerName = task.sourceConnectionId
    ? getConnectionName(task.sourceConnectionId)
    : "[源服务器名]"; // 占位符，如果 sourceConnectionId 未提供
    
  const targetPath = task.remoteTargetPath || "[目标路径]"; // 占位符，如果 remoteTargetPath 未提供

  // 如果 sourceConnectionId, remoteTargetPath 都未提供，且没有子任务（无法获取文件名），则退回显示原始任务ID
  if (!task.sourceConnectionId && !task.remoteTargetPath && (!task.subTasks || task.subTasks.length === 0)) {
    return `任务ID: ${task.taskId}`;
  }
  
  return `${sourceServerName} (${fileName} -> ${targetPath})`;
};


// 数据结构参考
interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  progress?: number; // 0-100
  message?: string;
  transferMethodUsed?: 'rsync' | 'scp';
}

interface TransferTask {
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  createdAt: string | Date;
  updatedAt: string | Date;
  subTasks: TransferSubTask[];
  overallProgress?: number;
  sourceConnectionId?: number; 
  remoteTargetPath?: string; 
}

const transferTasks = ref<TransferTask[]>([]);
const isLoading = ref(false);
const errorLoading = ref<string | null>(null);
const pollingIntervalId = ref<number | null>(null);

// Computed property for sorted and limited tasks
const displayedTasks = computed(() => {
  // Create a new array to avoid mutating the original transferTasks ref directly during sort
  return [...transferTasks.value]
    .sort((a, b) => {
      // Ensure createdAt is treated as a Date object for comparison
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime(); // For descending order (newest first)
    })
    .slice(0, 5); // Limit to the 5 newest tasks
});

// 计算正在进行中的任务数量
const activeTasksCount = computed(() => {
  return transferTasks.value.filter(t => ['queued', 'in-progress', 'connecting', 'transferring', 'cancelling'].includes(t.status)).length;
});

const fetchTransferTasks = async () => {
  isLoading.value = true;
  errorLoading.value = null;
  try {
    // 假设后端API路径为 /api/v1/transfers/status，且返回数据结构为 { data: TransferTask[] }
    // 请根据实际API调整这里的类型和数据访问
    const response = await apiClient.get<{ data: TransferTask[] }>('/transfers/status');
    const rawTasks = Array.isArray(response.data.data) ? response.data.data : (Array.isArray(response.data) ? response.data : []);
    transferTasks.value = rawTasks.map(task => {
      // 优先信任后端已经是 'cancelled' 或其他最终状态
      if (['completed', 'failed', 'cancelled', 'partially-completed'].includes(task.status)) {
        return task;
      }
      // 对于仍在进行中或正在取消中的任务
      if (['in-progress', 'cancelling', 'queued', 'connecting', 'transferring'].includes(task.status)) {
        // 如果它有子任务，并且所有子任务都已是 'cancelled'
        if (task.subTasks && task.subTasks.length > 0 && task.subTasks.every((st: TransferSubTask) => st.status === 'cancelled')) {
          // 则认为主任务也应该被标记为 'cancelled'
          // 这有助于处理后端主任务状态更新延迟或遗漏的情况
          return { ...task, status: 'cancelled' as TransferTask['status'] };
        }
        // 如果任务状态是 'cancelling' 但它没有子任务 (或子任务列表为空)
        // 这种情况也应视为已取消
        else if (task.status === 'cancelling' && (!task.subTasks || task.subTasks.length === 0)) {
            return { ...task, status: 'cancelled' as TransferTask['status'] };
        }
      }
      return task;
    });
  } catch (error: any) {
    console.error("Failed to fetch transfer tasks:", error);
    errorLoading.value = error.response?.data?.message || error.message || t('transferProgressModal.error.unknown', '未知错误');
  } finally {
    isLoading.value = false;
  }
};

const getDisplayStatus = (status: string): string => {
  const statusKeyMap: Record<string, string> = {
    'queued': 'transferProgressModal.status.queued',
    'in-progress': 'transferProgressModal.status.inProgress',
    'completed': 'transferProgressModal.status.completed',
    'failed': 'transferProgressModal.status.failed',
    'partially-completed': 'transferProgressModal.status.partiallyCompleted',
    'connecting': 'transferProgressModal.status.connecting',
    'transferring': 'transferProgressModal.status.transferring',
    'cancelling': 'transferProgressModal.status.cancelling',
    'cancelled': 'transferProgressModal.status.cancelled', 
  };
  // 提供一个默认的回退文本，以防i18n key缺失
  const defaultText = status.charAt(0).toUpperCase() + status.slice(1).replace('-', ' ');
  return t(statusKeyMap[status] || `status.${status}`, defaultText);
};

const formatDate = (dateInput: string | Date): string => {
  if (!dateInput) return '';
  try {
    // +++ 使用 i18n 的 locale 进行日期格式化 +++
    return new Date(dateInput).toLocaleString(locale.value, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (e) {
    return String(dateInput); 
  }
};

onMounted(() => {
  if (props.visible) {
    fetchTransferTasks();
    if (pollingIntervalId.value === null) {
       pollingIntervalId.value = window.setInterval(fetchTransferTasks, 5000);
    }
  }
});

onUnmounted(() => {
  if (pollingIntervalId.value !== null) {
    clearInterval(pollingIntervalId.value);
    pollingIntervalId.value = null;
  }
});

watch(() => props.visible, (newVisible) => {
  // internalVisible.value = newVisible; // 由下面的watch处理
  if (newVisible) {
    fetchTransferTasks(); // 模态框可见时立即获取一次数据
    if (pollingIntervalId.value === null) { // 只有在没有定时器时才启动
      pollingIntervalId.value = window.setInterval(fetchTransferTasks, 5000);
    }
  } else {
    if (pollingIntervalId.value !== null) {
      clearInterval(pollingIntervalId.value);
      pollingIntervalId.value = null;
    }
  }
}, { immediate: false }); // immediate: false 避免在组件初始化时立即执行，onMounted已处理首次加载

// --- 模态框可见性控制 ---
const internalVisible = ref(props.visible);

// 监听 props.visible 的变化来更新 internalVisible
watch(() => props.visible, (newVisibleValue) => {
  internalVisible.value = newVisibleValue;
}, { immediate: true }); // 确保初始状态同步

// 监听 internalVisible 的变化来 emit update:visible
watch(internalVisible, (newVal) => {
  if (newVal !== props.visible) {
    emit('update:visible', newVal);
  }
});

const handleClose = () => {
  internalVisible.value = false;
};

const isTaskCancellable = (taskStatus: TransferTask['status']): boolean => {
  return ['queued', 'in-progress', 'connecting', 'transferring', 'cancelling'].includes(taskStatus);
};

const isTaskCancelling = (taskStatus: TransferTask['status']): boolean => {
  return taskStatus === 'cancelling';
};

const handleCancelTask = async (taskId: string) => {
  // 可以在这里添加一个确认对话框
  // const confirmed = window.confirm(t('transferProgressModal.confirmCancel', '您确定要终止此传输任务吗？'));
  // if (!confirmed) return;

  try {
    // 更新UI，将任务状态临时设置为 'cancelling' 或禁用按钮
    const task = transferTasks.value.find(t => t.taskId === taskId);
    if (task) {

    }

    await apiClient.post(`/transfers/cancel/${taskId}`);
    const taskBeingCancelled = transferTasks.value.find(t => t.taskId === taskId);
    if (taskBeingCancelled && ['queued', 'in-progress', 'connecting', 'transferring'].includes(taskBeingCancelled.status)) {
      taskBeingCancelled.status = 'cancelling';
    }
    
    // 立即刷新一次列表，或者等待下一次轮询
    fetchTransferTasks();
  } catch (error: any) {
    console.error(`Failed to cancel task ${taskId}:`, error);
  }
};

</script>

<template>
  <Teleport to="body">
    <!-- ==================== 移动端特化视图 (Bottom Sheet 抽屉) ==================== -->
    <Transition name="bottom-sheet">
      <div
        v-if="internalVisible && isMobileMode"
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="handleClose"
      >
        <div class="mobile-transfer-sheet w-full max-h-[85vh] h-[85vh] flex flex-col bg-background border-t border-border/50 rounded-t-2xl shadow-2xl overflow-hidden select-text">
          
          <!-- 1. 顶部手柄条与导航栏 -->
          <div class="flex-shrink-0 pt-2.5 pb-2.5 px-4 border-b border-border/40 bg-header/40 select-none">
            <!-- 拖拽手柄条 -->
            <div class="w-10 h-1 bg-border/80 rounded-full mx-auto mb-2 cursor-pointer" @click="handleClose"></div>

            <div class="flex items-center justify-between">
              <!-- 左侧手动刷新按钮 -->
              <button
                type="button"
                @click="fetchTransferTasks"
                :disabled="isLoading"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground active:bg-border/30 disabled:opacity-50 transition-colors -ml-1 cursor-pointer"
                :title="t('common.refresh', '刷新')"
              >
                <i :class="['fas fa-sync-alt text-xs', { 'fa-spin': isLoading }]"></i>
              </button>

              <!-- 居中标题与活动任务徽标 -->
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-sm font-semibold text-foreground tracking-tight">
                  {{ t('transferProgressModal.title', '文件传输进度') }}
                </span>
                <span
                  v-if="activeTasksCount > 0"
                  class="px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 animate-pulse"
                >
                  {{ activeTasksCount }} {{ t('transferProgressModal.runningTasks', '进行中') }}
                </span>
              </div>

              <!-- 右侧收起按钮 (移除文字，保持纯图标) -->
              <button
                type="button"
                @click="handleClose"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground active:bg-border/30 transition-colors -mr-1 cursor-pointer"
                :title="t('common.close', '收起')"
              >
                <i class="fas fa-chevron-down text-sm"></i>
              </button>
            </div>
          </div>

          <!-- 2. 移动端任务列表区 -->
          <div class="flex-grow overflow-y-auto p-3 space-y-3 overscroll-contain">
            <!-- 加载中状态 (初次加载) -->
            <div v-if="isLoading && transferTasks.length === 0" class="text-center text-text-secondary py-14">
              <svg class="animate-spin h-8 w-8 text-primary mx-auto mb-2.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p class="text-xs font-medium">{{ t('transferProgressModal.loading', '正在加载传输任务...') }}</p>
            </div>

            <!-- 加载出错状态 -->
            <div v-else-if="errorLoading" class="text-center text-red-400 bg-red-500/10 border border-red-500/20 p-4 rounded-xl text-xs">
              <p class="font-semibold mb-1">{{ t('transferProgressModal.errorLoadingTitle', '加载错误') }}</p>
              <p class="opacity-90">{{ t('transferProgressModal.errorLoading', { error: errorLoading }) }}</p>
              <button @click="fetchTransferTasks" class="mt-2.5 px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-xs transition-colors">
                {{ t('common.retry', '重试') }}
              </button>
            </div>

            <!-- 空状态：无任务 -->
            <div v-else-if="!isLoading && transferTasks.length === 0" class="text-center text-text-secondary py-16 flex flex-col items-center">
              <div class="w-12 h-12 rounded-2xl bg-border/30 flex items-center justify-center text-text-secondary/60 mb-3 text-xl">
                <i class="fas fa-exchange-alt"></i>
              </div>
              <p class="text-sm font-medium mb-1">{{ t('transferProgressModal.noTasks', '当前没有活动的传输任务') }}</p>
              <p class="text-xs text-text-secondary/60">{{ t('transferProgressModal.noTasksTip', '在文件管理器中上传或下载时将在此显示进度') }}</p>
            </div>

            <!-- 任务卡片流 -->
            <div v-else class="space-y-2.5">
              <div
                v-for="task in displayedTasks"
                :key="task.taskId"
                class="bg-header/40 border border-border/40 rounded-xl p-3 shadow-xs space-y-2.5"
              >
                <!-- 卡片头部：路径信息与状态徽章 -->
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-grow">
                    <!-- 文件名与传输方向 -->
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-foreground truncate">
                      <i class="fas fa-file-alt text-primary/70 text-xs flex-shrink-0"></i>
                      <span class="truncate">{{ (task.subTasks && task.subTasks.length > 0) ? task.subTasks[0].sourceItemName : task.taskId }}</span>
                    </div>
                    <!-- 服务器及路径 -->
                    <div class="flex items-center gap-1 text-[11px] text-text-secondary truncate mt-0.5">
                      <span class="truncate max-w-[120px]">{{ task.sourceConnectionId ? getConnectionName(task.sourceConnectionId) : '[本地]' }}</span>
                      <i class="fas fa-arrow-right text-[9px] opacity-60"></i>
                      <span class="truncate max-w-[140px]">{{ task.remoteTargetPath || '[目标]' }}</span>
                    </div>
                  </div>

                  <!-- 状态胶囊 -->
                  <span
                    :class="[
                      'px-2 py-0.5 text-[11px] font-semibold rounded-full flex-shrink-0',
                      task.status === 'completed' ? 'bg-green-500/15 text-green-400 border border-green-500/30' :
                      task.status === 'failed' ? 'bg-red-500/15 text-red-400 border border-red-500/30' :
                      task.status === 'in-progress' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' :
                      task.status === 'cancelled' ? 'bg-gray-500/15 text-gray-400 border border-gray-500/30' :
                      'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30'
                    ]"
                  >
                    {{ getDisplayStatus(task.status) }}
                  </span>
                </div>

                <!-- 进度条与百分比 -->
                <div v-if="task.overallProgress !== undefined" class="space-y-1">
                  <div class="flex justify-between text-[11px] text-text-secondary">
                    <span>{{ t('transferProgressModal.task.overallProgress', '整体进度') }}</span>
                    <span class="font-mono font-medium text-foreground">{{ task.overallProgress }}%</span>
                  </div>
                  <div class="w-full bg-input rounded-full h-1.5 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :class="task.status === 'failed' ? 'bg-red-500' : (task.status === 'completed' ? 'bg-green-500' : 'bg-primary')"
                      :style="{ width: task.overallProgress + '%' }"
                    ></div>
                  </div>
                </div>

                <!-- 时间与操作行 -->
                <div class="flex items-center justify-between text-[11px] pt-0.5 border-t border-border/20">
                  <span class="text-text-secondary/70">
                    {{ formatDate(task.createdAt) }}
                  </span>

                  <!-- 终止任务按钮 -->
                  <button
                    v-if="isTaskCancellable(task.status)"
                    @click="handleCancelTask(task.taskId)"
                    :disabled="isTaskCancelling(task.status)"
                    class="px-2 py-1 text-xs text-red-400 bg-red-500/10 hover:bg-red-500/20 active:scale-95 disabled:opacity-50 rounded-lg flex items-center gap-1 transition-all"
                    :title="isTaskCancelling(task.status) ? t('transferProgressModal.cancellingTooltip', '终止中...') : t('transferProgressModal.cancelTaskTooltip', '终止任务')"
                  >
                    <i v-if="isTaskCancelling(task.status)" class="fas fa-spinner fa-spin text-[10px]"></i>
                    <i v-else class="fas fa-stop text-[10px]"></i>
                    <span>{{ isTaskCancelling(task.status) ? t('transferProgressModal.cancellingButton', '终止中') : t('transferProgressModal.cancelButton', '终止') }}</span>
                  </button>
                </div>

                <!-- 子任务折叠详情 -->
                <details v-if="task.subTasks && task.subTasks.length > 0" class="pt-1 group">
                  <summary class="text-xs font-medium text-primary hover:text-primary-hover cursor-pointer list-none flex items-center justify-between py-1 select-none">
                    <span>{{ t('transferProgressModal.subTasks.titleToggle', { count: task.subTasks.length }) }}</span>
                    <i class="fas fa-chevron-down text-[10px] text-primary/70 transition-transform duration-200 group-open:rotate-180"></i>
                  </summary>
                  <div class="mt-1.5 space-y-1.5">
                    <div
                      v-for="subTask in task.subTasks"
                      :key="subTask.subTaskId"
                      class="text-xs p-2 rounded-lg bg-background border border-border/40 space-y-1"
                    >
                      <div class="flex items-center justify-between gap-1">
                        <span class="font-medium text-foreground truncate max-w-[200px]">{{ subTask.sourceItemName }}</span>
                        <span
                          :class="[
                            'px-1.5 py-0.2 rounded text-[10px] font-semibold flex-shrink-0',
                            subTask.status === 'completed' ? 'bg-green-500/15 text-green-400' :
                            subTask.status === 'failed' ? 'bg-red-500/15 text-red-400' :
                            subTask.status === 'transferring' || subTask.status === 'connecting' ? 'bg-blue-500/15 text-blue-400' :
                            subTask.status === 'cancelled' ? 'bg-gray-500/15 text-gray-400' :
                            'bg-yellow-500/15 text-yellow-400'
                          ]"
                        >
                          {{ getDisplayStatus(subTask.status) }}
                          <template v-if="subTask.progress !== undefined"> ({{ subTask.progress }}%)</template>
                        </span>
                      </div>
                      <div class="text-[11px] text-text-secondary flex items-center justify-between">
                        <span>{{ getConnectionName(subTask.connectionId) }}</span>
                        <span v-if="subTask.transferMethodUsed" class="uppercase font-mono text-[10px] opacity-75">{{ subTask.transferMethodUsed }}</span>
                      </div>
                      <p v-if="subTask.status === 'failed' && subTask.message" class="text-[11px] text-red-400 break-all bg-red-500/10 p-1 rounded">
                        {{ subTask.message }}
                      </p>
                    </div>
                  </div>
                </details>
              </div>
            </div>

            <!-- 底部安全垫片 -->
            <div class="sheet-safe-bottom shrink-0"></div>
          </div>

        </div>
      </div>
    </Transition>

    <!-- ==================== 桌面端原有视图 (居中固定模态框) ==================== -->
    <div
      v-if="internalVisible && !isMobileMode"
      class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4"
      @click.self="handleClose"
    >
      <div class="bg-background text-foreground p-6 rounded-lg shadow-xl border w-full max-w-3xl max-h-[85vh] flex flex-col" :style="{ borderColor: 'var(--border-color)' }">
        <!-- Header -->
        <h3 class="text-xl font-semibold text-center mb-6 flex-shrink-0">
          {{ t('transferProgressModal.title', '文件传输进度') }}
        </h3>

        <!-- Content Area -->
        <div class="flex-grow overflow-y-auto mb-6 pr-2 space-y-4 custom-scrollbar">
          <div v-if="isLoading && transferTasks.length === 0" class="text-center text-text-secondary py-10">
            <svg class="animate-spin h-8 w-8 text-primary mx-auto mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ t('transferProgressModal.loading', '正在加载传输任务...') }}
          </div>
          <div v-else-if="errorLoading" class="text-center text-red-500 bg-red-50 p-4 rounded-md">
            <p class="font-semibold">{{ t('transferProgressModal.errorLoadingTitle', '加载错误') }}</p>
            <p>{{ t('transferProgressModal.errorLoading', { error: errorLoading }) }}</p>
          </div>
          <div v-else-if="!isLoading && transferTasks.length === 0" class="text-center text-text-secondary py-10">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-gray-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {{ t('transferProgressModal.noTasks', '当前没有活动的传输任务。') }}
          </div>
          <div v-else class="space-y-3">
            <div v-for="task in displayedTasks" :key="task.taskId" class="bg-background-alt p-3 rounded-lg border shadow-sm hover:shadow-md transition-shadow" :style="{ borderColor: 'var(--border-color)' }">
              <div class="flex justify-between items-start mb-2">
                <div>
                  <span class="font-semibold text-md block">{{ t('transferProgressModal.task.idLabel', '任务') }}: {{ formatTaskTitle(task) }}</span>
                  <span class="text-xs text-text-muted">{{ t('transferProgressModal.task.createdAt', '创建于') }}: {{ formatDate(task.createdAt) }}</span>
                </div>
                <div class="flex items-center space-x-2">
                  <span :class="['px-2.5 py-1 text-xs font-semibold rounded-full',
                    { 'bg-green-100 text-green-700': task.status === 'completed' },
                    { 'bg-red-100 text-red-700': task.status === 'failed' },
                    { 'bg-yellow-100 text-yellow-700': task.status === 'partially-completed' || task.status === 'queued' || task.status === 'cancelling' },
                    { 'bg-blue-100 text-blue-700': task.status === 'in-progress' },
                    { 'bg-gray-100 text-gray-700': task.status === 'cancelled' }
                  ]">
                    {{ getDisplayStatus(task.status) }}
                  </span>
                  <button
                    v-if="isTaskCancellable(task.status)"
                    @click="handleCancelTask(task.taskId)"
                    :disabled="isTaskCancelling(task.status)"
                    class="px-2 py-0.5 text-xs bg-red-500 hover:bg-red-600 text-white rounded-md focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    :title="isTaskCancelling(task.status) ? t('transferProgressModal.cancellingTooltip', '终止中...') : t('transferProgressModal.cancelTaskTooltip', '终止任务')"
                  >
                    <i v-if="isTaskCancelling(task.status)" class="fas fa-spinner fa-spin mr-1"></i>
                    {{ isTaskCancelling(task.status) ? t('transferProgressModal.cancellingButton', '终止中') : t('transferProgressModal.cancelButton', '终止') }}
                  </button>
                </div>
              </div>

              <div v-if="task.overallProgress !== undefined" class="mb-2">
                <div class="flex justify-between text-xs text-text-secondary mb-0.5">
                  <span>{{ t('transferProgressModal.task.overallProgress', '整体进度') }}</span>
                  <span>{{ task.overallProgress }}%</span>
                </div>
                <div class="w-full bg-border rounded-full h-1.5">
                  <div class="bg-primary h-1.5 rounded-full" :style="{ width: task.overallProgress + '%' }"></div>
                </div>
              </div>

              <details v-if="task.subTasks && task.subTasks.length > 0" class="mt-2 group">
                <summary class="text-xs font-medium text-primary hover:underline cursor-pointer list-none">
                  {{ t('transferProgressModal.subTasks.titleToggle', { count: task.subTasks.length }) }}
                  <span class="group-open:hidden">+</span><span class="hidden group-open:inline">-</span>
                </summary>
                <ul class="mt-2 space-y-1.5 pl-3 border-l ml-1" :style="{ borderLeftColor: 'var(--border-color)' }">
                  <li v-for="subTask in task.subTasks" :key="subTask.subTaskId" class="text-xs p-1.5 rounded bg-background border" :style="{ borderColor: 'var(--border-color)' }">
                    <p><strong>{{ t('transferProgressModal.subTask.source', '源文件') }}:</strong> {{ subTask.sourceItemName }}</p>
                    <p><strong>{{ t('transferProgressModal.subTask.connectionId', '目标连接') }}:</strong> {{ getConnectionName(subTask.connectionId) }}</p>
                    <div class="flex items-center">
                      <strong class="mr-1">{{ t('transferProgressModal.subTask.status', '状态') }}:</strong>
                      <span :class="['px-2 py-0.5 text-xs font-semibold rounded-full',
                        { 'bg-green-100 text-green-700': subTask.status === 'completed' },
                        { 'bg-red-100 text-red-700': subTask.status === 'failed' },
                        { 'bg-yellow-100 text-yellow-700': subTask.status === 'queued' || subTask.status === 'cancelling' },
                        { 'bg-blue-100 text-blue-700': subTask.status === 'transferring' || subTask.status === 'connecting' },
                        { 'bg-gray-100 text-gray-700': subTask.status === 'cancelled' }
                      ]">
                        {{ getDisplayStatus(subTask.status) }}
                      </span>
                      <span v-if="subTask.progress !== undefined" class="ml-1 text-xs text-text-secondary"> ({{ subTask.progress }}%)</span>
                    </div>
                    <p v-if="subTask.transferMethodUsed"><strong>{{ t('transferProgressModal.subTask.method', '方法') }}:</strong> {{ subTask.transferMethodUsed }}</p>
                    <p v-if="subTask.status === 'failed' && subTask.message" class="text-red-600">
                      <strong>{{ t('transferProgressModal.subTask.error', '错误') }}:</strong> {{ subTask.message }}
                    </p>
                  </li>
                </ul>
              </details>
              <div v-else-if="task.subTasks && task.subTasks.length === 0" class="mt-2 text-xs text-text-muted">
                 {{ t('transferProgressModal.subTasks.noSubTasks', '没有子任务。') }}
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex justify-end items-center pt-4 mt-auto flex-shrink-0 border-t" :style="{ borderTopColor: 'var(--border-color)' }">
          <button
            @click="handleClose"
            class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out"
          >
            {{ t('common.close', '关闭') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.bg-overlay {
  background-color: rgba(0, 0, 0, 0.6);
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(128, 128, 128, 0.3);
  border-radius: 10px;
  border: 2px solid transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background-color: rgba(128, 128, 128, 0.5);
}

.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.3) transparent;
}

/* 遮罩淡入淡出动效 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.24s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

/* 抽屉底部弹性滑入滑出动效 */
.bottom-sheet-enter-active .mobile-transfer-sheet {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .mobile-transfer-sheet {
  transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1);
}

.bottom-sheet-enter-from .mobile-transfer-sheet,
.bottom-sheet-leave-to .mobile-transfer-sheet {
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 12px);
}
</style>
