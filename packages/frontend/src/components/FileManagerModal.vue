<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import FileManager from './FileManager.vue';
import MobileFileManagerModal from './MobileFileManagerModal.vue';

const props = defineProps<{
  visible: boolean;
  sessionId: string | null;
  sessionName?: string | null;
  fileManagerPropsMap: Map<string, any>;
  isMobile?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
</script>

<template>
  <!-- 移动端专属文件管理器 Bottom Sheet 弹窗 -->
  <MobileFileManagerModal
    v-if="props.isMobile"
    :visible="props.visible"
    :session-id="props.sessionId"
    :session-name="props.sessionName"
    :file-manager-props-map="props.fileManagerPropsMap"
    @close="emit('close')"
  />

  <!-- 桌面端全尺寸居中弹窗 -->
  <div
    v-else
    v-show="props.visible && props.sessionId && props.fileManagerPropsMap.get(props.sessionId)"
    class="file-manager-modal fixed inset-0 z-50 flex items-center justify-center p-4 transition-colors"
    :style="{ backgroundColor: 'var(--overlay-bg-color)' }"
    @click.self="emit('close')"
  >
    <div class="bg-background shadow-xl w-full flex flex-col overflow-hidden border border-border rounded-lg max-w-4xl h-[85vh]">
      <!-- 头部标题栏与关闭按钮 -->
      <div class="flex justify-between items-center px-4 py-2.5 border-b border-border flex-shrink-0 bg-header">
        <h2 class="text-lg font-semibold text-foreground truncate flex items-center gap-2">
          <i class="fas fa-folder-open text-primary text-base"></i>
          <span>{{ t('fileManager.modalTitle', '文件管理器') }} ({{ props.sessionName || props.sessionId || '未知会话' }})</span>
        </h2>
        <button
          @click="emit('close')"
          class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-text-secondary hover:text-foreground transition-colors shrink-0"
          :title="t('common.close', '关闭')"
        >
          <i class="fas fa-times text-base sm:text-xl"></i>
        </button>
      </div>

      <!-- 文件管理器内容视图 -->
      <div class="flex-grow overflow-hidden relative">
        <template v-for="propsData in props.fileManagerPropsMap.values()" :key="`${propsData.sessionId}-desktop`">
          <div v-show="propsData.sessionId === props.sessionId" class="h-full">
            <FileManager
              :session-id="propsData.sessionId"
              :instance-id="propsData.instanceId"
              :db-connection-id="propsData.dbConnectionId"
              :ws-deps="propsData.wsDeps"
              :is-mobile="false"
              class="h-full"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
