<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import FileManager from './FileManager.vue';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

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

const isModalVisible = computed(() => {
  return props.visible && !!props.sessionId && !!props.fileManagerPropsMap.get(props.sessionId);
});

const title = computed(() => {
  return `${t('fileManager.modalTitle', '文件管理器')} (${props.sessionName || props.sessionId || '未知会话'})`;
});
</script>

<template>
  <MobileBottomSheet
    :visible="isModalVisible"
    :keep-alive="true"
    :title="title"
    icon="fas fa-folder-open"
    height="h-[92vh]"
    max-height="max-h-[92vh]"
    @close="emit('close')"
  >
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
  </MobileBottomSheet>
</template>
