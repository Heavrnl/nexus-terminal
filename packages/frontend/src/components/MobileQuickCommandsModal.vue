<script setup lang="ts">
import { defineProps, defineEmits, onMounted, onBeforeUnmount } from 'vue';
import MobileBottomSheet from './common/MobileBottomSheet.vue';
import MobileQuickCommandsView from '../views/MobileQuickCommandsView.vue'; // 导入移动端快捷指令视图
import { useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents'; // 导入事件订阅器
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'execute-command', command: string): void;
}>();

const { t } = useI18n();

const closeModal = () => {
  emit('close');
};

// 处理从 QuickCommandsView 传来的事件
const handleCommandExecute = (command: string) => {
  emit('execute-command', command);
  closeModal(); // 选择指令后自动关闭
};

const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();

// 当发送命令时自动关闭抽屉
const handleSendCommand = () => {
  closeModal();
};

onMounted(() => {
  onWorkspaceEvent('terminal:sendCommand', handleSendCommand);
});

onBeforeUnmount(() => {
  offWorkspaceEvent('terminal:sendCommand', handleSendCommand);
});
</script>

<template>
  <MobileBottomSheet
    :visible="props.isVisible"
    :title="t('quickCommands.title', '快捷指令')"
    icon="fas fa-bolt"
    height="h-[72vh]"
    max-height="max-h-[80vh]"
    @close="closeModal"
  >
    <MobileQuickCommandsView :instance-id="'modal'" @execute-command="handleCommandExecute" />
  </MobileBottomSheet>
</template>