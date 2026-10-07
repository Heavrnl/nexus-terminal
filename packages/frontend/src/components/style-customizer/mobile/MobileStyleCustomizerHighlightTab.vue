<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '../../common/ToggleSwitch.vue';
import MobileHighlightRuleEditModal from './MobileHighlightRuleEditModal.vue';
import { useTerminalHighlightStore } from '../../../stores/terminal-highlight.store';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import { useConfirmDialog } from '../../../composables/useConfirmDialog';
import { ansiToHtml } from '../../../utils/terminal-highlighter';
import type { TerminalHighlightGroup } from '../../../types/terminal-highlight.types';

const { t } = useI18n();
const highlightStore = useTerminalHighlightStore();
const notificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();

const showPreview = ref(false);
const isEditModalOpen = ref(false);
const editingGroup = ref<TerminalHighlightGroup | null>(null);

// 调色盘候选色
const PALETTE_COLORS = [
  '#22c55e', '#ef4444', '#f59e0b', '#06b6d4',
  '#3b82f6', '#c084fc', '#f43f5e', '#2dd4bf',
];

// 实时预览样本
type PreviewSampleKey = 'docker' | 'log' | 'network';
const currentSample = ref<PreviewSampleKey>('docker');

const SAMPLES: Record<PreviewSampleKey, string> = {
  docker: `$ docker ps -a
CONTAINER ID   IMAGE          COMMAND                  STATUS                    PORTS                  NAMES
9b8a7c6d5e4f   nginx:alpine   "/docker-entrypoint.…"   Up 2 hours                0.0.0.0:80->80/tcp     web-frontend
1a2b3c4d5e6f   mysql:8.0      "docker-entrypoint.s…"   Exited (1) 10 mins ago    0.0.0.0:3306->3306/tcp db-production
4f5e6d7c8b9a   redis:7-alpine "docker-entrypoint.s…"   Restarting (1) 5 secs ago                        cache-redis`,

  log: `[2026-03-29 14:22:01.345] [INFO] Server started successfully on port 8080
[2026-03-29 14:22:05.120] [WARN] Connection pool reaching 80% capacity
[2026-03-29 14:22:09.891] [ERROR] Database query timeout after 5000ms: SELECT * FROM users
[2026-03-29 14:22:15.002] [FATAL] OutOfMemoryError in worker thread #3
[2026-03-29 14:22:18.441] [DEBUG] Garbage collection reclaimed 512MB`,

  network: `$ ifconfig
eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.1.100  netmask 255.255.255.0  broadcast 192.168.1.255
        inet6 fe80::1ff:fe23:4567:890a  prefixlen 64  scopeid 0x20<link>
        ether 00:1a:2b:3c:4d:5e  txqueuelen 1000  (Ethernet)
$ curl -I https://api.nexus-terminal.io:8443/health
HTTP/2 200 OK
content-type: application/json; charset=utf-8`,
};

// 实时计算预览 HTML
const renderedPreviewHtml = computed(() => {
  const text = SAMPLES[currentSample.value];
  if (!highlightStore.enabled) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const highlightedAnsi = highlightStore.highlight(text);
  return ansiToHtml(typeof highlightedAnsi === 'string' ? highlightedAnsi : text);
});

// 切换规则状态
const toggleGroup = (group: TerminalHighlightGroup) => {
  highlightStore.toggleGroup(group.id);
};

// 更新规则颜色
const updateGroupColor = (group: TerminalHighlightGroup, color: string) => {
  highlightStore.updateGroup(group.id, { color });
};

// 打开新建分组弹窗
const openAddModal = () => {
  editingGroup.value = null;
  isEditModalOpen.value = true;
};

// 打开编辑分组弹窗
const openEditModal = (group: TerminalHighlightGroup) => {
  editingGroup.value = group;
  isEditModalOpen.value = true;
};

// 删除高亮规则
const handleDeleteGroup = async (group: TerminalHighlightGroup) => {
  const confirmed = await showConfirmDialog({
    title: '删除高亮规则',
    message: `确定要删除高亮规则“${group.name}”吗？`,
  });
  if (confirmed) {
    highlightStore.deleteGroup(group.id);
    notificationsStore.addNotification({ type: 'success', message: '已删除高亮规则' });
  }
};

// 重置默认规则
const handleReset = async () => {
  const confirmed = await showConfirmDialog({
    title: '恢复预设规则',
    message: '确定要重置为系统默认高亮规则吗？您的自定义高亮规则将被清空。',
  });
  if (confirmed) {
    highlightStore.resetToDefault();
    notificationsStore.addNotification({ type: 'info', message: '已恢复默认高亮规则' });
  }
};
</script>

<template>
  <div class="mobile-highlight-tab space-y-4 text-foreground">
    <!-- 1. 功能总开关大卡片 -->
    <div class="bg-header/30 border border-border/50 rounded-2xl p-3.5 flex items-center justify-between gap-3 shadow-2xs">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <i class="fas fa-highlighter text-xs"></i>
          </div>
          <span class="text-xs font-semibold text-foreground">终端代码与关键字高亮</span>
        </div>
        <p class="text-[11px] text-text-secondary/70 mt-1 leading-relaxed">
          实时识别 Docker 状态、IP 地址、日志级别等并着色
        </p>
      </div>

      <ToggleSwitch
        :model-value="highlightStore.enabled"
        @update:model-value="highlightStore.toggleEnabled"
      />
    </div>

    <!-- 2. 实时效果预览 (折叠卡片) -->
    <div class="border border-border/50 rounded-2xl bg-header/20 overflow-hidden">
      <button
        type="button"
        @click="showPreview = !showPreview"
        class="w-full flex items-center justify-between px-3.5 py-3 text-xs font-medium text-text-secondary hover:text-foreground cursor-pointer"
      >
        <span class="flex items-center gap-1.5">
          <i class="fas fa-eye text-xs text-primary/70"></i>
          <span>实时效果预览</span>
        </span>
        <i :class="['fas text-xs transition-transform', showPreview ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      </button>

      <div v-show="showPreview" class="px-3 pb-3 space-y-2 border-t border-border/30 pt-2.5">
        <!-- 样例切换药丸 -->
        <div class="flex items-center gap-1.5">
          <button
            v-for="k in (['docker', 'log', 'network'] as PreviewSampleKey[])"
            :key="k"
            type="button"
            @click="currentSample = k"
            class="px-2.5 py-1 text-[11px] rounded-lg border font-medium transition-colors cursor-pointer"
            :class="currentSample === k ? 'bg-primary border-primary text-primary-foreground shadow-2xs' : 'bg-background border-border/50 text-text-secondary'"
          >
            {{ k === 'docker' ? 'Docker 状态' : k === 'log' ? '日志级别' : '网络地址' }}
          </button>
        </div>

        <!-- 终端样式黑色预览框 -->
        <div class="bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[11px] leading-relaxed p-3 rounded-xl overflow-x-auto max-h-[160px] border border-border/40 select-all shadow-inner">
          <pre class="whitespace-pre font-mono" v-html="renderedPreviewHtml"></pre>
        </div>
      </div>
    </div>

    <!-- 3. 规则管理卡片流 -->
    <div class="space-y-2">
      <div class="flex items-center justify-between px-0.5">
        <div class="text-xs font-semibold text-text-secondary">高亮规则清单</div>
        <div class="flex items-center gap-2">
          <!-- 添加新规则按钮 -->
          <button
            type="button"
            @click="openAddModal"
            class="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all shadow-2xs flex items-center gap-1 cursor-pointer"
          >
            <i class="fas fa-plus text-[10px]"></i>
            <span>添加规则</span>
          </button>
          <!-- 恢复预设按钮 -->
          <button
            type="button"
            @click="handleReset"
            class="text-[11px] text-text-secondary hover:text-foreground cursor-pointer px-1"
          >
            恢复预设
          </button>
        </div>
      </div>

      <div class="space-y-2.5">
        <div
          v-for="group in highlightStore.groups"
          :key="group.id"
          class="bg-header/30 border border-border/50 rounded-2xl p-3 space-y-2.5 transition-all"
          :class="{ 'opacity-60': !group.enabled }"
        >
          <!-- 规则头部：名称、优先级与开关 -->
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <!-- 颜色指示圆点 -->
              <span
                class="w-3 h-3 rounded-full shrink-0 shadow-2xs border border-black/10"
                :style="{ backgroundColor: group.color }"
              ></span>
              <span class="text-xs font-semibold text-foreground truncate">{{ group.name }}</span>
              <span class="text-[9px] px-1.5 py-0.2 rounded bg-border/40 text-text-secondary shrink-0 font-mono">
                优先级: {{ group.priority }}
              </span>
            </div>

            <!-- 右侧动作区：编辑、删除与开关 -->
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                @click="openEditModal(group)"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
                title="编辑规则"
              >
                <i class="fas fa-pencil-alt text-xs text-primary"></i>
              </button>

              <button
                type="button"
                @click="handleDeleteGroup(group)"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all cursor-pointer"
                title="删除规则"
              >
                <i class="fas fa-trash-alt text-xs"></i>
              </button>

              <!-- 单项开关 -->
              <ToggleSwitch
                :model-value="group.enabled"
                @update:model-value="toggleGroup(group)"
              />
            </div>
          </div>

          <!-- 快速调色盘 -->
          <div v-if="group.enabled" class="flex items-center gap-1.5 pt-1 border-t border-border/20">
            <span class="text-[10px] text-text-secondary/60 shrink-0">着色:</span>
            <div class="flex items-center gap-1.5 flex-wrap flex-1">
              <button
                v-for="color in PALETTE_COLORS"
                :key="color"
                type="button"
                @click="updateGroupColor(group, color)"
                class="w-4.5 h-4.5 rounded-full border border-black/10 transition-transform cursor-pointer"
                :class="{ 'scale-125 ring-2 ring-primary ring-offset-1 ring-offset-background': group.color === color }"
                :style="{ backgroundColor: color }"
              ></button>
            </div>
            <!-- 原生颜色自选器 -->
            <div class="relative w-5 h-5 rounded-full overflow-hidden border border-border shrink-0 cursor-pointer">
              <input
                type="color"
                :value="group.color"
                @input="updateGroupColor(group, ($event.target as HTMLInputElement).value)"
                class="absolute -inset-2 w-10 h-10 opacity-0 cursor-pointer"
              />
              <div class="w-full h-full" :style="{ backgroundColor: group.color }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. 移动端高亮规则添加/编辑抽屉模态 -->
    <MobileHighlightRuleEditModal
      :is-visible="isEditModalOpen"
      :group-to-edit="editingGroup"
      @close="isEditModalOpen = false"
    />
  </div>
</template>
