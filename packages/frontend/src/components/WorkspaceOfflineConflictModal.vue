<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';

const { t } = useI18n();
const workspaceSyncStore = useWorkspaceSyncStore();

const conflict = computed(() => workspaceSyncStore.offlineConflict);
const isResolving = computed(() => workspaceSyncStore.isResolvingOfflineConflict);

const formattedCloudTime = computed(() => {
  const ts = conflict.value?.cloudUpdatedAt;
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '';
  }
});

const handlePullCloud = async () => {
  await workspaceSyncStore.resolveOfflineConflict('pull_cloud');
};

const handlePushLocal = async () => {
  await workspaceSyncStore.resolveOfflineConflict('push_local');
};
</script>

<template>
  <Transition name="fade">
    <div
      v-if="conflict"
      class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 select-none"
      @click.stop
    >
      <div
        class="relative max-w-md w-full bg-background border border-border/80 rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center"
        style="background-color: var(--app-bg-color);"
      >
        <div class="flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-500 mb-4">
          <i class="fas fa-code-branch text-2xl"></i>
        </div>

        <h2 class="text-lg font-bold text-foreground mb-2">
          {{ t('workspaceSync.offlineConflictTitle', '云端工作区在离线期间已被更新') }}
        </h2>

        <p class="text-xs sm:text-sm text-text-secondary leading-relaxed mb-3">
          {{
            t(
              'workspaceSync.offlineConflictDesc',
              '桌面端已恢复与云端服务的连接，但检测到您在离线期间已有其他设备接管并修改了云端工作区。请选择同步处理方式：'
            )
          }}
        </p>

        <p v-if="formattedCloudTime" class="text-xs text-text-secondary/80 mb-5">
          {{ t('workspaceSync.offlineConflictCloudTime', { time: formattedCloudTime }) }}
        </p>

        <div class="flex flex-col gap-2.5 w-full">
          <button
            type="button"
            class="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-xl bg-primary hover:bg-primary-hover text-white text-sm font-medium shadow-sm transition-all cursor-pointer disabled:opacity-60"
            :disabled="isResolving"
            @click="handlePullCloud"
          >
            <i v-if="isResolving" class="fas fa-spinner fa-spin mr-2"></i>
            <i v-else class="fas fa-cloud-download-alt mr-2"></i>
            {{ t('workspaceSync.offlineConflictPullCloud', '拉取云端最新工作区（推荐）') }}
          </button>

          <button
            type="button"
            class="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-500 border border-amber-500/30 text-sm font-medium transition-all cursor-pointer disabled:opacity-60"
            :disabled="isResolving"
            @click="handlePushLocal"
          >
            <i class="fas fa-cloud-upload-alt mr-2"></i>
            {{ t('workspaceSync.offlineConflictPushLocal', '以当前桌面工作区覆盖并接管云端') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
