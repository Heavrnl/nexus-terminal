<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';
import { useSessionStore } from '../stores/session.store';
import AddEditFavoritePathForm from './AddEditFavoritePathForm.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'navigate-to-path', path: string): void;
}>();

const { t } = useI18n();
const favoritePathsStore = useFavoritePathsStore();
const sessionStore = useSessionStore();
const { showConfirmDialog } = useConfirmDialog();

const searchTerm = ref('');
const showAddEditModal = ref(false);
const editingPathItem = ref<FavoritePathItem | null>(null);

const filteredPaths = computed(() => {
  if (!searchTerm.value) {
    return favoritePathsStore.favoritePaths;
  }
  const lowerSearchTerm = searchTerm.value.toLowerCase();
  return favoritePathsStore.favoritePaths.filter(
    (p) =>
      p.path.toLowerCase().includes(lowerSearchTerm) ||
      (p.name && p.name.toLowerCase().includes(lowerSearchTerm))
  );
});

const currentSortBy = computed(() => favoritePathsStore.currentSortBy);

const sortButtonIcon = computed(() => {
  return currentSortBy.value === 'name' ? 'fas fa-sort-alpha-down' : 'fas fa-clock';
});

const toggleSort = () => {
  const newSortBy = currentSortBy.value === 'name' ? 'last_used_at' : 'name';
  favoritePathsStore.setSortBy(newSortBy);
};

const closeModal = () => {
  emit('close');
};

const handleItemClick = async (pathItem: FavoritePathItem) => {
  try {
    await favoritePathsStore.markPathAsUsed(pathItem.id, t);
  } catch (error) {
    console.error('Failed to mark path as used:', error);
  }
  emit('navigate-to-path', pathItem.path);
  closeModal();
};

const openAddModal = () => {
  editingPathItem.value = null;
  showAddEditModal.value = true;
};

const openEditModal = (pathItem: FavoritePathItem) => {
  editingPathItem.value = { ...pathItem };
  showAddEditModal.value = true;
};

const handleDelete = async (pathItem: FavoritePathItem) => {
  const confirmed = await showConfirmDialog({
    message: t('favoritePaths.confirmDelete', { name: pathItem.name || pathItem.path })
  });
  if (confirmed) {
    try {
      await favoritePathsStore.deleteFavoritePath(pathItem.id, t);
    } catch (error) {
      console.error('Failed to delete favorite path from modal:', error);
    }
  }
};

const handleSendToTerminal = (pathItem: FavoritePathItem) => {
  const activeSession = sessionStore.activeSession;
  if (activeSession && activeSession.terminalManager) {
    const escapedPath = `"${pathItem.path.replace(/"/g, '\\"')}"`;
    const command = `cd ${escapedPath}\n`;
    try {
      activeSession.terminalManager.sendData(command);
    } catch (error) {
      console.error('Failed to send cd command to terminal:', error);
    }
  }
};

watch(() => props.isVisible, (val) => {
  if (val) {
    searchTerm.value = '';
  }
});
</script>

<template>
  <MobileBottomSheet
    :visible="props.isVisible"
    :title="t('fileManager.favoritePathsTooltip', '常用路径收藏夹')"
    icon="fas fa-star"
    height="h-[75vh]"
    max-height="max-h-[80vh]"
    @close="closeModal"
  >
    <template #sub-header>
      <!-- 工具栏：搜索与排序/添加按钮 -->
      <div class="px-4 py-2.5 flex items-center gap-2 border-b border-border/40 bg-background">
        <div class="relative flex-grow">
          <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-xs text-text-secondary pointer-events-none"></i>
          <input
            type="text"
            v-model="searchTerm"
            :placeholder="t('favoritePaths.searchPlaceholder', '搜索名称或路径...')"
            class="w-full h-9 bg-input border border-border rounded-xl pl-8 pr-3 text-xs sm:text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          />
        </div>
        <button
          @click="toggleSort"
          class="w-9 h-9 flex items-center justify-center bg-header/60 border border-border rounded-xl text-text-secondary hover:text-primary active:scale-95 transition-all shrink-0 cursor-pointer"
          :title="currentSortBy === 'name' ? '按名称排序' : '按时间排序'"
        >
          <i :class="sortButtonIcon"></i>
        </button>
        <button
          @click="openAddModal"
          class="h-9 px-3 flex items-center justify-center gap-1.5 bg-primary text-white rounded-xl text-xs font-semibold active:scale-95 transition-all shadow-xs shrink-0 cursor-pointer"
          :title="t('favoritePaths.addNew', '添加常用路径')"
        >
          <i class="fas fa-plus text-xs"></i>
          <span>添加</span>
        </button>
      </div>
    </template>

    <!-- 路径列表 -->
    <div class="overflow-y-auto flex-grow space-y-2 p-3 overscroll-contain">
      <div v-if="favoritePathsStore.isLoading && filteredPaths.length === 0" class="py-8 flex flex-col items-center justify-center text-text-secondary gap-2 text-xs">
        <i class="fas fa-spinner fa-spin text-lg text-primary"></i>
        <span>{{ t('favoritePaths.loading', '正在加载收藏路径...') }}</span>
      </div>
      <div v-else-if="!favoritePathsStore.isLoading && filteredPaths.length === 0" class="py-10 text-center text-text-secondary text-xs">
        <i class="fas fa-star-half-alt text-2xl text-text-secondary/50 block mb-2"></i>
        <span>{{ searchTerm ? t('favoritePaths.noResults', '未找到匹配的路径') : t('favoritePaths.noFavorites', '暂无收藏路径，点击右上角添加') }}</span>
      </div>
      <div
        v-else
        v-for="favPath in filteredPaths"
        :key="favPath.id"
        class="w-full flex items-center justify-between p-3 rounded-xl bg-header/30 border border-border/40 hover:bg-header/60 active:bg-primary/10 transition-colors cursor-pointer"
        @click="handleItemClick(favPath)"
      >
        <div class="min-w-0 flex-1 mr-2">
          <div class="font-medium text-[13px] text-foreground truncate">
            {{ favPath.name || favPath.path }}
          </div>
          <div class="text-[11px] font-mono text-text-secondary truncate mt-0.5">
            {{ favPath.path }}
          </div>
        </div>
        <!-- 触屏常驻操作按钮组 -->
        <div class="flex items-center gap-1 shrink-0" @click.stop>
          <button
            @click="handleSendToTerminal(favPath)"
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-primary active:bg-primary/20 transition-colors cursor-pointer"
            title="在终端切换至此路径"
          >
            <i class="fas fa-terminal text-xs"></i>
          </button>
          <button
            @click="openEditModal(favPath)"
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-amber-500 active:bg-amber-500/20 transition-colors cursor-pointer"
            :title="t('common.edit')"
          >
            <i class="fas fa-pencil-alt text-xs"></i>
          </button>
          <button
            @click="handleDelete(favPath)"
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-rose-500 active:bg-rose-500/20 transition-colors cursor-pointer"
            :title="t('common.delete')"
          >
            <i class="fas fa-trash-alt text-xs"></i>
          </button>
        </div>
      </div>
    </div>
  </MobileBottomSheet>

  <!-- 添加/编辑常用路径子模态框 -->
  <AddEditFavoritePathForm
    :is-visible="showAddEditModal"
    :path-item="editingPathItem"
    :is-mobile="true"
    @close="showAddEditModal = false"
  />
</template>
