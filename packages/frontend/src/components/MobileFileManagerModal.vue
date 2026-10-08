<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import FileManager from './FileManager.vue';

const props = defineProps<{
  visible: boolean;
  sessionId: string | null;
  sessionName?: string | null;
  fileManagerPropsMap: Map<string, any>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
</script>

<template>
  <div
    v-show="props.visible && props.sessionId && props.fileManagerPropsMap.get(props.sessionId)"
    class="mobile-file-manager-modal fixed inset-0 z-50 flex flex-col justify-end transition-colors"
    :style="{ backgroundColor: 'var(--overlay-bg-color)' }"
    @click.self="emit('close')"
  >
    <div class="bg-background shadow-xl w-full flex flex-col overflow-hidden border border-border rounded-t-2xl max-h-[92vh] h-[92vh] border-b-0 pb-[env(safe-area-inset-bottom,0px)]">
      <!-- 移动端顶部药丸手柄条 -->
      <div class="pt-2.5 pb-1 flex justify-center shrink-0 cursor-pointer" @click="emit('close')">
        <div class="w-10 h-1 bg-border/80 rounded-full"></div>
      </div>

      <!-- 头部标题栏与向下箭头收起按钮 -->
      <div class="flex justify-between items-center px-4 py-2 border-b border-border flex-shrink-0 bg-header">
        <h2 class="text-sm font-semibold text-foreground truncate flex items-center gap-2">
          <i class="fas fa-folder-open text-primary text-sm"></i>
          <span>{{ t('fileManager.modalTitle', '文件管理器') }} ({{ props.sessionName || props.sessionId || '未知会话' }})</span>
        </h2>
        <button
          @click="emit('close')"
          class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-text-secondary hover:text-foreground transition-colors shrink-0"
          :title="t('common.close', '关闭')"
        >
          <i class="fas fa-chevron-down text-base"></i>
        </button>
      </div>

      <!-- 文件管理器内容视图 -->
      <div class="flex-grow overflow-hidden relative">
        <template v-for="propsData in props.fileManagerPropsMap.values()" :key="`${propsData.sessionId}-mobile`">
          <div v-show="propsData.sessionId === props.sessionId" class="h-full">
            <FileManager
              :session-id="propsData.sessionId"
              :instance-id="propsData.instanceId"
              :db-connection-id="propsData.dbConnectionId"
              :ws-deps="propsData.wsDeps"
              :is-mobile="true"
              class="h-full"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mobile-file-manager-modal {
  animation: fadeIn 0.15s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
