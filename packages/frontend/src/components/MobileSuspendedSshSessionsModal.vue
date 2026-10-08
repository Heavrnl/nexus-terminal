<script setup lang="ts">
import { defineProps, defineEmits, onMounted, onUnmounted } from 'vue';
import MobileBottomSheet from './common/MobileBottomSheet.vue';
import SuspendedSshSessionsView from '../views/SuspendedSshSessionsView.vue'; // 导入视图
import { useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents'; // 导入事件订阅器和取消订阅器
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();

const closeModal = () => {
  emit('close');
};

const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff(); // 获取取消订阅函数

// 挂起会话操作完成后自动关闭抽屉
const handleSuspendedSessionActionCompleted = () => {
  closeModal();
};

onMounted(() => {
  onWorkspaceEvent('suspendedSession:actionCompleted', handleSuspendedSessionActionCompleted);
});

onUnmounted(() => {
  offWorkspaceEvent('suspendedSession:actionCompleted', handleSuspendedSessionActionCompleted);
});
</script>

<template>
  <MobileBottomSheet
    :visible="props.isVisible"
    :title="t('suspendedSshSessions.modalTitle', '挂起的 SSH 会话')"
    icon="fas fa-pause-circle"
    height="h-[72vh]"
    max-height="max-h-[80vh]"
    @close="closeModal"
  >
    <SuspendedSshSessionsView />
  </MobileBottomSheet>
</template>