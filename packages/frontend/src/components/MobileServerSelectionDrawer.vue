<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useTagsStore } from '../stores/tags.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';

interface Props {
  visible: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'select-connection', connectionId: number): void;
  (e: 'request-add-connection'): void;
  (e: 'request-edit-connection', connection: ConnectionInfo): void;
}>();

const { t } = useI18n();
const connectionsStore = useConnectionsStore();
const tagsStore = useTagsStore();
const uiNotificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();

const { connections } = storeToRefs(connectionsStore);
const { tags } = storeToRefs(tagsStore);

// 搜索词与标签过滤
const searchTerm = ref('');
const selectedTagId = ref<number | 'untagged' | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

// 操作菜单状态 (ActionSheet)
const actionSheetTarget = ref<ConnectionInfo | null>(null);

// 打开抽屉时聚焦搜索框
watch(() => props.visible, (isOpen) => {
  if (isOpen) {
    actionSheetTarget.value = null;
    searchTerm.value = '';
    selectedTagId.value = null;
  }
});

// 计算标签映射表 (tagId -> tagName)
const tagMap = computed(() => new Map(tags.value.map(tag => [tag.id, tag.name])));

// 过滤后的连接列表
const filteredConnections = computed(() => {
  const query = searchTerm.value.trim().toLowerCase();
  
  return connections.value.filter(conn => {
    // 1. 标签筛选
    if (selectedTagId.value !== null) {
      if (selectedTagId.value === 'untagged') {
        if (conn.tag_ids && conn.tag_ids.length > 0) return false;
      } else {
        if (!conn.tag_ids || !conn.tag_ids.includes(selectedTagId.value)) return false;
      }
    }

    // 2. 文本搜索
    if (!query) return true;

    if (conn.name && conn.name.toLowerCase().includes(query)) return true;
    if (conn.host && conn.host.toLowerCase().includes(query)) return true;
    if (conn.username && conn.username.toLowerCase().includes(query)) return true;
    if (conn.tag_ids && conn.tag_ids.length > 0) {
      for (const tagId of conn.tag_ids) {
        const tagName = tagMap.value.get(tagId);
        if (tagName && tagName.toLowerCase().includes(query)) return true;
      }
    }
    return false;
  });
});

// 选择并连接
const handleSelect = (connectionId: number) => {
  emit('select-connection', connectionId);
  emit('close');
};

// 新建连接
const handleRequestAdd = () => {
  emit('close');
  emit('request-add-connection');
};

// 打开操作面板
const openActionSheet = (conn: ConnectionInfo) => {
  actionSheetTarget.value = conn;
};

// 关闭操作面板
const closeActionSheet = () => {
  actionSheetTarget.value = null;
};

// 触发编辑
const handleActionEdit = () => {
  const conn = actionSheetTarget.value;
  closeActionSheet();
  if (conn) {
    emit('close');
    emit('request-edit-connection', conn);
  }
};

// 触发克隆
const handleActionClone = async () => {
  const conn = actionSheetTarget.value;
  closeActionSheet();
  if (!conn) return;

  const allConnections = connectionsStore.connections;
  let newName = `${conn.name} (1)`;
  let counter = 1;
  const baseName = conn.name;
  const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedBaseName} \\((\\d+)\\)$`);

  while (allConnections.some(c => c.name === newName)) {
    counter++;
    newName = `${baseName} (${counter})`;
  }

  try {
    await connectionsStore.cloneConnection(conn.id, newName);
    uiNotificationsStore.addNotification({
      message: t('connections.actions.cloneSuccess', '克隆成功'),
      type: 'success'
    });
  } catch (error: any) {
    console.error('克隆连接失败:', error);
    uiNotificationsStore.addNotification({
      message: error?.message || t('connections.actions.cloneFailed', '克隆失败'),
      type: 'error'
    });
  }
};

// 触发删除
const handleActionDelete = async () => {
  const conn = actionSheetTarget.value;
  closeActionSheet();
  if (!conn) return;

  const confirmed = await showConfirmDialog({
    message: t('connections.prompts.confirmDelete', { name: conn.name || conn.host })
  });

  if (confirmed) {
    try {
      await connectionsStore.deleteConnection(conn.id);
      uiNotificationsStore.addNotification({
        message: t('connections.deleteSuccess', '连接已删除'),
        type: 'success'
      });
    } catch (error: any) {
      console.error('删除连接失败:', error);
      uiNotificationsStore.addNotification({
        message: error?.message || t('connections.deleteFailed', '删除连接失败'),
        type: 'error'
      });
    }
  }
};
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        v-if="props.visible"
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs"
        @click.self="emit('close')"
      >
        <!-- 底部滑出抽屉容器 -->
        <div class="mobile-server-sheet w-full max-h-[85vh] h-[85vh] flex flex-col bg-background border-t border-border/50 rounded-t-2xl shadow-2xl overflow-hidden">
          
          <!-- 1. 顶部拖拽指示条与标题栏 -->
          <div class="flex-shrink-0 pt-2.5 pb-2 px-4 border-b border-border/40 bg-header/40">
            <!-- 拖拽手柄条 -->
            <div class="w-10 h-1 bg-border/80 rounded-full mx-auto mb-2 cursor-pointer" @click="emit('close')"></div>

            <div class="flex items-center justify-between">
              <!-- 收起按钮 -->
              <button
                class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-border/30 transition-colors -ml-1.5"
                @click="emit('close')"
                :title="t('common.close', '关闭')"
              >
                <i class="fas fa-chevron-down text-base"></i>
              </button>

              <!-- 标题 -->
              <h3 class="text-base font-semibold text-foreground tracking-tight">
                {{ t('terminalTabBar.selectServerTitle') }}
              </h3>

              <!-- + 新建连接按钮 -->
              <button
                class="px-2.5 py-1 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all flex items-center gap-1 -mr-1"
                @click="handleRequestAdd"
                :title="t('connections.addConnection', '添加连接')"
              >
                <i class="fas fa-plus text-xs"></i>
                <span>{{ t('common.add', '新建') }}</span>
              </button>
            </div>
          </div>

          <!-- 2. 搜索栏 -->
          <div class="p-3 pb-2 flex-shrink-0 border-b border-border/20 bg-background">
            <div class="relative flex items-center w-full">
              <i class="fas fa-search absolute left-3 text-text-secondary text-xs pointer-events-none"></i>
              <input
                ref="searchInputRef"
                type="text"
                v-model="searchTerm"
                :placeholder="t('workspaceConnectionList.searchPlaceholder', '搜索服务器名称、IP 或标签...')"
                class="w-full pl-8 pr-8 py-2 bg-input/80 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-text-secondary/60 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all"
              />
              <button
                v-if="searchTerm"
                @click="searchTerm = ''"
                class="absolute right-2.5 w-5 h-5 rounded-full flex items-center justify-center text-text-secondary hover:text-foreground text-xs"
              >
                <i class="fas fa-times-circle"></i>
              </button>
            </div>
          </div>

          <!-- 3. 横向滑动标签胶囊 (Pill Tags) -->
          <div
            v-if="tags.length > 0"
            class="px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar scroll-smooth flex-shrink-0 border-b border-border/20 bg-header/20"
          >
            <!-- 全部 -->
            <button
              class="px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all"
              :class="selectedTagId === null
                ? 'bg-primary text-button-text shadow-xs'
                : 'bg-input/70 text-text-secondary border border-border/40 hover:bg-input active:scale-95'"
              @click="selectedTagId = null"
            >
              {{ t('common.all', '全部') }} ({{ connections.length }})
            </button>

            <!-- 用户标签 -->
            <button
              v-for="tag in tags"
              :key="tag.id"
              class="px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all"
              :class="selectedTagId === tag.id
                ? 'bg-primary text-button-text shadow-xs'
                : 'bg-input/70 text-text-secondary border border-border/40 hover:bg-input active:scale-95'"
              @click="selectedTagId = tag.id"
            >
              {{ tag.name }}
            </button>

            <!-- 未标记 -->
            <button
              class="px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all"
              :class="selectedTagId === 'untagged'
                ? 'bg-primary text-button-text shadow-xs'
                : 'bg-input/70 text-text-secondary border border-border/40 hover:bg-input active:scale-95'"
              @click="selectedTagId = 'untagged'"
            >
              {{ t('workspaceConnectionList.untagged', '未标记') }}
            </button>
          </div>

          <!-- 4. 服务器卡片列表区 -->
          <div class="flex-grow overflow-y-auto p-3 space-y-2">
            <!-- 空状态：无搜索结果 -->
            <div
              v-if="filteredConnections.length === 0 && (searchTerm || selectedTagId !== null)"
              class="py-12 text-center text-text-secondary flex flex-col items-center justify-center"
            >
              <i class="fas fa-search text-3xl mb-2.5 opacity-40"></i>
              <p class="text-sm font-medium">{{ t('workspaceConnectionList.noResults', '未找到匹配的服务器') }}</p>
              <button
                @click="searchTerm = ''; selectedTagId = null;"
                class="mt-3 px-3 py-1.5 text-xs text-primary bg-primary/10 hover:bg-primary/20 rounded-lg transition-colors"
              >
                {{ t('common.clearFilter', '清空筛选') }}
              </button>
            </div>

            <!-- 空状态：无任何连接 -->
            <div
              v-else-if="connections.length === 0"
              class="py-16 text-center text-text-secondary flex flex-col items-center justify-center"
            >
              <i class="fas fa-server text-4xl mb-3 opacity-30"></i>
              <p class="text-sm font-medium mb-1">{{ t('connections.noConnections', '暂无连接配置') }}</p>
              <p class="text-xs opacity-70 mb-4">{{ t('connections.createConnectionTip', '点击下方按钮添加第一台服务器') }}</p>
              <button
                class="px-4 py-2 bg-primary text-button-text rounded-xl text-sm font-medium shadow-md active:scale-95 transition-all flex items-center gap-2"
                @click="handleRequestAdd"
              >
                <i class="fas fa-plus text-xs"></i>
                <span>{{ t('connections.addFirstConnection', '添加第一个连接') }}</span>
              </button>
            </div>

            <!-- 服务器卡片流 -->
            <div
              v-for="conn in filteredConnections"
              :key="conn.id"
              class="group bg-header/40 hover:bg-header/80 active:bg-header border border-border/40 hover:border-border rounded-xl p-3 flex items-center gap-3 transition-all cursor-pointer shadow-xs"
              @click="handleSelect(conn.id)"
            >
              <!-- 协议图标徽章 -->
              <div
                class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-base transition-colors"
                :class="conn.type === 'RDP'
                  ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                  : conn.type === 'VNC'
                    ? 'bg-purple-500/15 text-purple-400 border border-purple-500/25'
                    : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'"
              >
                <i :class="conn.type === 'RDP' ? 'fas fa-desktop' : (conn.type === 'VNC' ? 'fas fa-chalkboard' : 'fas fa-server')"></i>
              </div>

              <!-- 中间双行信息 -->
              <div class="flex-grow min-w-0">
                <div class="flex items-center gap-1.5 mb-0.5">
                  <span class="font-semibold text-sm text-foreground truncate max-w-[200px]">
                    {{ conn.name || conn.host }}
                  </span>
                  <span
                    class="px-1.5 py-0.2 rounded text-[10px] uppercase font-mono font-bold tracking-wider"
                    :class="conn.type === 'RDP'
                      ? 'bg-blue-500/10 text-blue-400'
                      : conn.type === 'VNC'
                        ? 'bg-purple-500/10 text-purple-400'
                        : 'bg-emerald-500/10 text-emerald-400'"
                  >
                    {{ conn.type }}
                  </span>
                </div>

                <div class="flex items-center gap-2 text-xs text-text-secondary truncate">
                  <span class="truncate">
                    {{ conn.username ? `${conn.username}@${conn.host}` : conn.host }}{{ conn.port ? `:${conn.port}` : '' }}
                  </span>
                </div>
              </div>

              <!-- 右侧直连箭头与更多操作按钮 -->
              <div class="flex items-center gap-1 flex-shrink-0">
                <!-- 更多选项按钮 (...) -->
                <button
                  class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-border/30 active:scale-95 transition-all"
                  @click.stop="openActionSheet(conn)"
                  :title="t('common.more', '更多选项')"
                >
                  <i class="fas fa-ellipsis-v text-xs"></i>
                </button>
              </div>
            </div>
          </div>

          <!-- 底部安全区垫片 -->
          <div class="sheet-safe-bottom shrink-0 bg-background"></div>
        </div>

        <!-- 5. 动作面板 (ActionSheet) -->
        <Transition name="fade">
          <div
            v-if="actionSheetTarget"
            class="fixed inset-0 z-60 flex flex-col justify-end bg-black/60 backdrop-blur-xs"
            @click.self="closeActionSheet"
          >
            <div class="w-full bg-background border-t border-border rounded-t-2xl p-4 space-y-2 shadow-2xl">
              <div class="text-center pb-2 border-b border-border/30">
                <p class="font-semibold text-sm text-foreground truncate">{{ actionSheetTarget.name || actionSheetTarget.host }}</p>
                <p class="text-xs text-text-secondary truncate">{{ actionSheetTarget.host }}</p>
              </div>

              <div class="space-y-1.5 pt-1">
                <!-- 立即连接 -->
                <button
                  @click="handleSelect(actionSheetTarget.id)"
                  class="w-full py-2.5 px-4 rounded-xl flex items-center gap-3 text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 active:scale-98 transition-all"
                >
                  <i class="fas fa-play text-xs w-4 text-center"></i>
                  <span>{{ t('workspaceConnectionList.connect', '立即连接') }}</span>
                </button>

                <!-- 编辑配置 -->
                <button
                  @click="handleActionEdit"
                  class="w-full py-2.5 px-4 rounded-xl flex items-center gap-3 text-sm font-medium text-foreground hover:bg-border/30 active:scale-98 transition-all"
                >
                  <i class="fas fa-edit text-xs w-4 text-center text-text-secondary"></i>
                  <span>{{ t('connections.actions.edit', '编辑配置') }}</span>
                </button>

                <!-- 复制/克隆 -->
                <button
                  @click="handleActionClone"
                  class="w-full py-2.5 px-4 rounded-xl flex items-center gap-3 text-sm font-medium text-foreground hover:bg-border/30 active:scale-98 transition-all"
                >
                  <i class="fas fa-clone text-xs w-4 text-center text-text-secondary"></i>
                  <span>{{ t('connections.actions.clone', '克隆副本') }}</span>
                </button>

                <!-- 删除 -->
                <button
                  @click="handleActionDelete"
                  class="w-full py-2.5 px-4 rounded-xl flex items-center gap-3 text-sm font-medium text-error hover:bg-error/10 active:scale-98 transition-all"
                >
                  <i class="fas fa-trash-alt text-xs w-4 text-center"></i>
                  <span>{{ t('connections.actions.delete', '删除服务器') }}</span>
                </button>
              </div>

              <!-- 取消按钮 -->
              <div class="pt-2">
                <button
                  @click="closeActionSheet"
                  class="w-full py-2.5 rounded-xl text-sm font-medium text-text-secondary hover:text-foreground bg-input/60 hover:bg-input transition-colors"
                >
                  {{ t('common.cancel', '取消') }}
                </button>
              </div>

              <div class="sheet-safe-bottom shrink-0"></div>
            </div>
          </div>
        </Transition>

      </div>
    </Transition>
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
.bottom-sheet-enter-active .mobile-server-sheet {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .mobile-server-sheet {
  transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1);
}

.bottom-sheet-enter-from .mobile-server-sheet,
.bottom-sheet-leave-to .mobile-server-sheet {
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
