<script setup lang="ts">
import MobileBottomSheet, { type MobileBottomSheetProps } from './common/MobileBottomSheet.vue';

const props = defineProps<MobileBottomSheetProps>();
const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'close'): void;
}>();
</script>

<template>
  <MobileBottomSheet
    v-bind="props"
    @update:visible="val => emit('update:visible', val)"
    @close="emit('close')"
  >
    <template #handle>
      <slot name="handle" />
    </template>
    <template #header>
      <slot name="header" />
    </template>
    <template #header-left>
      <slot name="header-left" />
    </template>
    <template #header-actions>
      <slot name="header-actions" />
    </template>
    <template #sub-header>
      <slot name="sub-header" />
    </template>
    <template #default>
      <slot />
    </template>
  </MobileBottomSheet>
</template>
