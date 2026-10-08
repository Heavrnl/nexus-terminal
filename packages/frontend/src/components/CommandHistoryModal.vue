<script setup lang="ts">
import MobileCommandHistoryModal from './MobileCommandHistoryModal.vue';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();
</script>

<template>
  <MobileCommandHistoryModal
    :is-visible="props.isVisible"
    @close="emit('close')"
  />
</template>
