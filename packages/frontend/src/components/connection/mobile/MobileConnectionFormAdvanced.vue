<script setup lang="ts">
import { ref, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import TagInput from '../../TagInput.vue';
import type { ProxyInfo } from '../../../stores/proxies.store';
import type { TagInfo } from '../../../stores/tags.store';
import type { ConnectionInfo } from '../../../stores/connections.store';

// 定义 Props
const props = defineProps({
  formData: {
    type: Object as PropType<{
      id?: number;
      type: 'SSH' | 'RDP' | 'VNC';
      proxy_id: number | null;
      jump_chain: Array<number | null> | null;
      proxy_type?: 'proxy' | 'jump' | null;
      tag_ids: number[];
      notes: string;
    }>,
    required: true
  },
  proxies: { type: Array as PropType<ProxyInfo[]>, required: true },
  connections: { type: Array as PropType<ConnectionInfo[]>, required: true },
  tags: { type: Array as PropType<TagInfo[]>, required: true },
  isProxyLoading: { type: Boolean, required: true },
  proxyStoreError: { type: String as PropType<string | null>, required: false, default: null },
  isTagLoading: { type: Boolean, required: true },
  tagStoreError: { type: String as PropType<string | null>, required: false, default: null },
  advancedConnectionMode: { type: String as PropType<'proxy' | 'jump'>, required: true },
  addJumpHost: { type: Function as PropType<() => void>, required: true },
  removeJumpHost: { type: Function as PropType<(index: number) => void>, required: true },
  isEditMode: { type: Boolean, default: false }
});

// 定义 Emits
const emit = defineEmits<{
  (e: 'create-tag', tagName: string): void;
  (e: 'delete-tag', tagId: number): void;
  (e: 'update:advancedConnectionMode', mode: 'proxy' | 'jump'): void;
}>();

const { t } = useI18n();

// 高级选项折叠状态 (移动端默认展开，用户亦可随时折叠)
const isExpanded = ref(true);

const handleCreateTagEvent = (tagName: string) => {
  emit('create-tag', tagName);
};

const handleDeleteTagEvent = (tagId: number) => {
  emit('delete-tag', tagId);
};

const setConnectionMode = (mode: 'proxy' | 'jump') => {
  if (props.advancedConnectionMode === mode) return;
  emit('update:advancedConnectionMode', mode);
};

const getAvailableJumpHostsForIndex = (currentIndex: number): ConnectionInfo[] => {
  return props.connections.filter(conn => {
    if (conn.type !== 'SSH') return false;
    if (props.isEditMode && props.formData.id === conn.id) return false;
    return !props.formData.jump_chain?.some((jumpHostId, index) => {
      return index !== currentIndex && jumpHostId === conn.id;
    });
  });
};
</script>

<template>
  <div class="bg-background border border-border/60 rounded-2xl shadow-2xs overflow-hidden">
    <!-- 折叠标题栏 -->
    <button
      type="button"
      @click="isExpanded = !isExpanded"
      class="w-full p-4 flex items-center justify-between text-left cursor-pointer active:bg-header/40 transition-colors select-none"
    >
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-xs">
          <i class="fas fa-sliders-h"></i>
        </div>
        <div>
          <span class="text-sm font-semibold text-foreground tracking-tight">
            {{ t('connections.form.sectionAdvanced', '高级选项') }}
          </span>
          <span class="text-[11px] text-text-secondary/70 ml-2">代理、跳板机、标签、备注</span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 text-text-secondary">
        <span class="text-xs">{{ isExpanded ? '收起' : '展开' }}</span>
        <i :class="['fas text-xs transition-transform duration-200', isExpanded ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      </div>
    </button>

    <!-- 折叠内容区 -->
    <div v-show="isExpanded" class="px-4 pb-4 pt-1 space-y-4 border-t border-border/40">
      <!-- 1. SSH 连接方式 (仅 SSH 支持代理/跳板机) -->
      <div v-if="props.formData.type === 'SSH'" class="space-y-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.connectionMode', '网络连接路由方式') }}
          </label>
          <div class="grid grid-cols-2 gap-1.5 p-1 bg-header/40 border border-border/60 rounded-xl">
            <button
              type="button"
              @click="setConnectionMode('proxy')"
              class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
              :class="props.advancedConnectionMode === 'proxy'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'text-text-secondary hover:text-foreground active:bg-border/30'"
            >
              <i class="fas fa-globe text-xs"></i>
              <span>{{ t('connections.form.connectionModeProxy', '正向代理') }}</span>
            </button>

            <button
              type="button"
              @click="setConnectionMode('jump')"
              class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
              :class="props.advancedConnectionMode === 'jump'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'text-text-secondary hover:text-foreground active:bg-border/30'"
            >
              <i class="fas fa-random text-xs"></i>
              <span>{{ t('connections.form.connectionModeJumpHost', '跳板机链') }}</span>
            </button>
          </div>
        </div>

        <!-- 代理选择器 (模式为 proxy 时) -->
        <div v-if="props.advancedConnectionMode === 'proxy'" class="space-y-1.5">
          <label for="m-conn-proxy" class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.proxy', '指定代理服务器') }}
          </label>
          <div class="relative">
            <select
              id="m-conn-proxy"
              v-model="props.formData.proxy_id"
              class="w-full h-10 pl-3 pr-8 text-xs bg-header/20 border border-border/60 rounded-xl text-foreground focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer"
            >
              <option :value="null">{{ t('connections.form.noProxy', '不使用代理 (直连)') }}</option>
              <option v-for="proxy in props.proxies" :key="proxy.id" :value="proxy.id">
                {{ proxy.name }} ({{ proxy.type }} - {{ proxy.host }}:{{ proxy.port }})
              </option>
            </select>
            <i class="fas fa-chevron-down absolute right-3 top-3.5 text-xs text-text-secondary pointer-events-none"></i>
          </div>
          <div v-if="props.isProxyLoading" class="text-[11px] text-text-secondary">{{ t('proxies.loading', '加载代理列表中...') }}</div>
          <div v-if="props.proxyStoreError" class="text-[11px] text-red-400">{{ t('proxies.error', { error: props.proxyStoreError }) }}</div>
        </div>

        <!-- 跳板机链配置 (模式为 jump 时) -->
        <div v-if="props.advancedConnectionMode === 'jump'" class="space-y-2.5">
          <div class="flex items-center justify-between">
            <label class="block text-xs font-medium text-text-secondary">
              {{ t('connections.form.jumpHostsTitle', '跳板机链配置') }}
            </label>
            <span class="text-[11px] text-text-secondary/70">自上而下顺序穿透</span>
          </div>

          <!-- 跳板机列表 -->
          <div v-if="props.formData.jump_chain && props.formData.jump_chain.length > 0" class="space-y-2">
            <div
              v-for="(jumpHostId, index) in props.formData.jump_chain"
              :key="index"
              class="flex items-center gap-2 p-2.5 bg-header/30 border border-border/60 rounded-xl"
            >
              <span class="w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">
                {{ index + 1 }}
              </span>

              <div class="relative flex-grow min-w-0">
                <select
                  v-model="props.formData.jump_chain[index]"
                  class="w-full h-9 pl-2.5 pr-7 text-xs bg-background border border-border/60 rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer"
                >
                  <option :value="null">{{ t('connections.form.selectJumpHost', '请选择跳板机节点') }}</option>
                  <option v-for="host in getAvailableJumpHostsForIndex(index)" :key="host.id" :value="host.id">
                    {{ host.name }} ({{ host.host }})
                  </option>
                </select>
                <i class="fas fa-chevron-down absolute right-2.5 top-3 text-[10px] text-text-secondary pointer-events-none"></i>
              </div>

              <!-- 移除此级跳板机 -->
              <button
                type="button"
                @click="props.removeJumpHost(index)"
                class="w-8 h-8 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 active:scale-95 flex items-center justify-center shrink-0 transition-all cursor-pointer"
                :title="t('connections.form.removeJumpHostTitle', '移除此跳板机')"
              >
                <i class="fas fa-times text-xs"></i>
              </button>
            </div>
          </div>

          <!-- 添加下一级跳板机按钮 -->
          <button
            type="button"
            @click="props.addJumpHost()"
            class="w-full h-9 rounded-xl border border-dashed border-primary/50 text-primary bg-primary/5 hover:bg-primary/10 active:scale-98 flex items-center justify-center gap-2 text-xs font-medium transition-all cursor-pointer"
          >
            <i class="fas fa-plus text-xs"></i>
            <span>{{ t('connections.form.addJumpHost', '添加跳板机') }}</span>
          </button>

          <div
            v-if="props.connections.filter(c => c.type === 'SSH' && (!props.isEditMode || c.id !== props.formData.id)).length === 0"
            class="text-[11px] text-amber-500 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl leading-relaxed"
          >
            {{ t('connections.form.noAvailableSshConnectionsForJump', '暂无可用的 SSH 连接作为跳板机，请先添加其他 SSH 连接。') }}
          </div>
        </div>
      </div>

      <!-- 2. 分类标签管理 -->
      <div class="space-y-1.5 pt-1">
        <label class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.tags', '分类标签') }}
        </label>
        <div class="mobile-tag-input-container">
          <TagInput
            v-model="props.formData.tag_ids"
            :available-tags="props.tags"
            :allow-create="true"
            :allow-delete="true"
            @create-tag="handleCreateTagEvent"
            @delete-tag="handleDeleteTagEvent"
            :placeholder="t('tags.inputPlaceholder', '输入或选择标签...')"
          />
        </div>
        <div v-if="props.isTagLoading" class="text-[11px] text-text-secondary">{{ t('tags.loading', '加载标签中...') }}</div>
        <div v-if="props.tagStoreError" class="text-[11px] text-red-400">{{ t('tags.error', { error: props.tagStoreError }) }}</div>
      </div>

      <!-- 3. 备注信息 -->
      <div class="space-y-1.5 pt-1">
        <label for="m-conn-notes" class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.notes', '备注与描述') }}
        </label>
        <textarea
          id="m-conn-notes"
          v-model="props.formData.notes"
          rows="3"
          placeholder="记录关于该服务器的用途、维护提醒等..."
          class="w-full p-3 text-xs bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors leading-relaxed"
        ></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.mobile-tag-input-container input) {
  height: 2.25rem;
  border-radius: 0.75rem;
  font-size: 0.75rem;
  background-color: var(--color-header, rgba(0,0,0,0.05));
}
</style>
