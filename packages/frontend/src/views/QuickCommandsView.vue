<template>
  <MobileQuickCommandsView
    v-if="isMobile"
    ref="mobileViewRef"
    :instance-id="props.instanceId"
    @execute-command="(cmd) => emit('execute-command', cmd)"
  />
  <DesktopQuickCommandsView
    v-else
    ref="desktopViewRef"
    :instance-id="props.instanceId"
    @execute-command="(cmd) => emit('execute-command', cmd)"
  />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import MobileQuickCommandsView from './MobileQuickCommandsView.vue';
import DesktopQuickCommandsView from './DesktopQuickCommandsView.vue';

const props = withDefaults(
  defineProps<{
    instanceId?: string;
  }>(),
  {
    instanceId: 'default',
  }
);

const emit = defineEmits<{
  (e: 'execute-command', command: string): void;
}>();

const { isMobile: isMobileDevice } = useDeviceDetection();
const isMobile = computed(() => isMobileDevice.value || (typeof window !== 'undefined' && window.innerWidth < 768));

const mobileViewRef = ref<InstanceType<typeof MobileQuickCommandsView> | null>(null);
const desktopViewRef = ref<InstanceType<typeof DesktopQuickCommandsView> | null>(null);

const focusSearchInput = () => {
  if (isMobile.value) {
    mobileViewRef.value?.focusSearchInput?.();
  } else {
    desktopViewRef.value?.focusSearchInput?.();
  }
};

defineExpose({
  focusSearchInput,
});
</script>
