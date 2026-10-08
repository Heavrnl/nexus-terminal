<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ConnectionInfo } from '../stores/connections.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import MobileAddConnectionModal from './MobileAddConnectionModal.vue';
import DesktopAddConnectionForm from './DesktopAddConnectionForm.vue';

// 定义组件发出的事件
const emit = defineEmits(['close', 'connection-added', 'connection-updated', 'connection-deleted']);

// 定义 Props
interface Props {
  connectionToEdit: ConnectionInfo | null;
  isMobile?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isMobile: undefined,
});

const { isMobile: detectedMobile } = useDeviceDetection();

// 视口尺寸响应式监听
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
const handleResize = () => {
  windowWidth.value = window.innerWidth;
};

onMounted(() => {
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
});

const isMobileMode = computed(() => {
  if (typeof props.isMobile === 'boolean') {
    return props.isMobile;
  }
  return detectedMobile.value || windowWidth.value < 768;
});
</script>

<template>
  <Teleport to="body">
    <!-- ==================== 移动端特化视图 (抽屉式底部弹窗) ==================== -->
    <Transition name="bottom-sheet">
      <MobileAddConnectionModal
        v-if="isMobileMode"
        :connection-to-edit="props.connectionToEdit"
        @close="emit('close')"
        @connection-added="emit('connection-added')"
        @connection-updated="emit('connection-updated')"
        @connection-deleted="emit('connection-deleted')"
      />
    </Transition>

    <!-- ==================== 桌面端原有视图 (居中固定模态框) ==================== -->
    <DesktopAddConnectionForm
      v-if="!isMobileMode"
      :connection-to-edit="props.connectionToEdit"
      @close="emit('close')"
      @connection-added="emit('connection-added')"
      @connection-updated="emit('connection-updated')"
      @connection-deleted="emit('connection-deleted')"
    />
  </Teleport>
</template>

<style scoped>
/* 遮罩淡入淡出动效 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.24s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

/* 抽屉底部弹性滑入滑出动效 */
.bottom-sheet-enter-active .mobile-form-sheet {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .mobile-form-sheet {
  transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1);
}

.bottom-sheet-enter-from .mobile-form-sheet,
.bottom-sheet-leave-to .mobile-form-sheet {
  transform: translateY(100%);
}
</style>
