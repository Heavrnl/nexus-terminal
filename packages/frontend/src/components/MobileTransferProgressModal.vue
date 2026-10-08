<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled';
  progress?: number;
  message?: string;
  transferMethodUsed?: 'rsync' | 'scp';
}

interface TransferTask {
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled';
  createdAt: string | Date;
  updatedAt: string | Date;
  subTasks: TransferSubTask[];
  overallProgress?: number;
  sourceConnectionId?: number; 
  remoteTargetPath?: string; 
}

const props = defineProps<{
  visible: boolean;
  transferTasks: TransferTask[];
  displayedTasks: TransferTask[];
  isLoading: boolean;
  errorLoading: string | null;
  activeTasksCount: number;
  getConnectionName: (id: number) => string;
  getDisplayStatus: (status: string) => string;
  formatDate: (date: string | Date) => string;
  isTaskCancellable: (status: any) => boolean;
  isTaskCancelling: (status: any) => boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'refresh'): void;
  (e: 'cancel-task', taskId: string): void;
}>();

const { t } = useI18n();

const handleClose = () => {
  emit('update:visible', false);
};
</script>

<template>
  <MobileBottomSheet
    :visible="props.visible"
    height="h-[85vh]"
    max-height="max-h-[85vh]"
    @close="handleClose"
  >
    <template #header-left>
      <!-- 左侧手动刷新按钮 -->
      <button
        type="button"
        @click="emit('refresh')"
        :disabled="props.isLoading"
        class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground active:bg-border/30 disabled:opacity-50 transition-colors -ml-1 cursor-pointer"
        :title="t('common.refresh', '刷新')"
      >
        <i :class="['fas fa-sync-alt text-xs', { 'fa-spin': props.isLoading }]"></i>
      </button>

      <!-- 居中标题与活动任务徽标 -->
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="text-sm font-semibold text-foreground tracking-tight">
          {{ t('transferProgressModal.title', '文件传输进度') }}
        </span>
        <span
          v-if="props.activeTasksCount > 0"
          class="px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 animate-pulse"
        >
          {{ props.activeTasksCount }} {{ t('transferProgressModal.runningTasks', '进行中') }}
        </span>
      </div>
    </template>

          <!-- 2. 移动端任务列表区 -->
          <div class="flex-grow overflow-y-auto p-3 space-y-3 overscroll-contain">
            <!-- 加载中状态 -->
            <div v-if="props.isLoading && props.transferTasks.length === 0" class="text-center text-text-secondary py-14">
              <svg class="animate-spin h-8 w-8 text-primary mx-auto mb-2.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p class="text-xs font-medium">{{ t('transferProgressModal.loading', '正在加载传输任务...') }}</p>
            </div>

            <!-- 加载出错状态 -->
            <div v-else-if="props.errorLoading" class="text-center text-red-400 bg-red-500/10 border border-red-500/20 p-4 rounded-xl text-xs">
              <p class="font-semibold mb-1">{{ t('transferProgressModal.errorLoadingTitle', '加载错误') }}</p>
              <p class="opacity-90">{{ t('transferProgressModal.errorLoading', { error: props.errorLoading }) }}</p>
              <button @click="emit('refresh')" class="mt-2.5 px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-xs transition-colors">
                {{ t('common.retry', '重试') }}
              </button>
            </div>

            <!-- 空状态 -->
            <div v-else-if="!props.isLoading && props.transferTasks.length === 0" class="text-center text-text-secondary py-16 flex flex-col items-center">
              <div class="w-12 h-12 rounded-2xl bg-border/30 flex items-center justify-center text-text-secondary/60 mb-3 text-xl">
                <i class="fas fa-exchange-alt"></i>
              </div>
              <p class="text-sm font-medium mb-1">{{ t('transferProgressModal.noTasks', '当前没有活动的传输任务') }}</p>
              <p class="text-xs text-text-secondary/60">{{ t('transferProgressModal.noTasksTip', '在文件管理器中上传或下载时将在此显示进度') }}</p>
            </div>

            <!-- 任务卡片流 -->
            <div v-else class="space-y-2.5">
              <div
                v-for="task in props.displayedTasks"
                :key="task.taskId"
                class="bg-header/40 border border-border/40 rounded-xl p-3 shadow-xs space-y-2.5"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-grow">
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-foreground truncate">
                      <i class="fas fa-file-alt text-primary/70 text-xs flex-shrink-0"></i>
                      <span class="truncate">{{ (task.subTasks && task.subTasks.length > 0) ? task.subTasks[0].sourceItemName : task.taskId }}</span>
                    </div>
                    <div class="flex items-center gap-1 text-[11px] text-text-secondary truncate mt-0.5">
                      <span class="truncate max-w-[120px]">{{ task.sourceConnectionId ? props.getConnectionName(task.sourceConnectionId) : '[本地]' }}</span>
                      <i class="fas fa-arrow-right text-[9px] opacity-60"></i>
                      <span class="truncate max-w-[140px]">{{ task.remoteTargetPath || '[目标]' }}</span>
                    </div>
                  </div>

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
                    {{ props.getDisplayStatus(task.status) }}
                  </span>
                </div>

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

                <div class="flex items-center justify-between text-[11px] pt-0.5 border-t border-border/20">
                  <span class="text-text-secondary/70">
                    {{ props.formatDate(task.createdAt) }}
                  </span>

                  <button
                    v-if="props.isTaskCancellable(task.status)"
                    @click="emit('cancel-task', task.taskId)"
                    :disabled="props.isTaskCancelling(task.status)"
                    class="px-2 py-1 text-xs text-red-400 bg-red-500/10 hover:bg-red-500/20 active:scale-95 disabled:opacity-50 rounded-lg flex items-center gap-1 transition-all"
                    :title="props.isTaskCancelling(task.status) ? t('transferProgressModal.cancellingTooltip', '终止中...') : t('transferProgressModal.cancelTaskTooltip', '终止任务')"
                  >
                    <i v-if="props.isTaskCancelling(task.status)" class="fas fa-spinner fa-spin text-[10px]"></i>
                    <i v-else class="fas fa-stop text-[10px]"></i>
                    <span>{{ props.isTaskCancelling(task.status) ? t('transferProgressModal.cancellingButton', '终止中') : t('transferProgressModal.cancelButton', '终止') }}</span>
                  </button>
                </div>

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
                          {{ props.getDisplayStatus(subTask.status) }}
                        </span>
                      </div>
                      <div v-if="subTask.progress !== undefined" class="w-full bg-input rounded-full h-1 overflow-hidden">
                        <div class="bg-primary h-1 rounded-full" :style="{ width: subTask.progress + '%' }"></div>
                      </div>
                      <p v-if="subTask.message" class="text-[10px] text-text-secondary truncate font-mono">
                        {{ subTask.message }}
                      </p>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </div>
  </MobileBottomSheet>
</template>
