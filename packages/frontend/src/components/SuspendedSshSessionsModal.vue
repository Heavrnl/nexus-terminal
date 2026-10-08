<script setup lang="ts">
import MobileSuspendedSshSessionsModal from './MobileSuspendedSshSessionsModal.vue';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();
</script>

<template>
  <MobileSuspendedSshSessionsModal
    :is-visible="props.isVisible"
    @close="emit('close')"
  />
</template>
