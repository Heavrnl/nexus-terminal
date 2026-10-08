<script setup lang="ts">
import MobileQuickCommandsModal from './MobileQuickCommandsModal.vue';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'execute-command', command: string): void;
}>();
</script>

<template>
  <MobileQuickCommandsModal
    :is-visible="props.isVisible"
    @close="emit('close')"
    @execute-command="(cmd) => emit('execute-command', cmd)"
  />
</template>
