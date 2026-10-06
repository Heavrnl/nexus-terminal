<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';
import { useSessionStore } from '../stores/session.store';
import AddEditFavoritePathForm from './AddEditFavoritePathForm.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';

const PADDING = 8; // px

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  triggerElement: {
    type: Object as PropType<HTMLElement | null>,
    default: null,
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['close', 'navigateToPath']);

const { t } = useI18n();
const favoritePathsStore = useFavoritePathsStore();
const sessionStore = useSessionStore();
const { showConfirmDialog } = useConfirmDialog();

const searchTerm = ref('');
const showAddEditModal = ref(false);
const editingPathItem = ref<FavoritePathItem | null>(null);
const modalContentRef = ref<HTMLElement | null>(null);
const modalStyle = ref<Record<string, string>>({});

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

const handleItemClick = async (pathItem: FavoritePathItem) => {
  try {
    await favoritePathsStore.markPathAsUsed(pathItem.id, t);
  } catch (error) {
    console.error('Failed to mark path as used:', error);
  }
  emit('navigateToPath', pathItem.path);
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
      console.error('[FavoritePathsModal] Failed to send command to active terminal:', error);
    }
  }
  closeModal(); 
};

const closeModal = () => {
  emit('close');
};

const updatePosition = () => {
  if (props.isMobile || !props.isVisible || !props.triggerElement || !modalContentRef.value) {
    return;
  }

  const triggerRect = props.triggerElement.getBoundingClientRect();
  const modalWidth = modalContentRef.value.offsetWidth;
  const modalHeight = modalContentRef.value.offsetHeight;

  if (modalWidth === 0 && modalHeight === 0 && props.isVisible) {
    nextTick(updatePosition);
    return;
  }
  
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let top = triggerRect.bottom + 2;
  let left = triggerRect.left;

  if (top + modalHeight + PADDING > viewportHeight) {
    top = triggerRect.top - modalHeight - 2;
  }

  if (top < PADDING) {
    top = PADDING;
  }

  if (left + modalWidth + PADDING > viewportWidth) {
    left = viewportWidth - modalWidth - PADDING;
  }

  if (left < PADDING) {
    left = PADDING;
  }

  modalStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
  };
};

const handleClickOutside = (event: MouseEvent) => {
  if (props.isMobile) return;
  if (props.triggerElement && props.triggerElement.contains(event.target as Node)) {
    return;
  }
  if (modalContentRef.value && !modalContentRef.value.contains(event.target as Node)) {
    if (!showAddEditModal.value) { 
      closeModal();
    }
  }
};

watch(() => props.isVisible, (newValue: boolean) => {
  if (newValue) {
    searchTerm.value = '';
    if (!props.isMobile) {
      document.addEventListener('mousedown', handleClickOutside);
      nextTick(() => {
        updatePosition();
        window.addEventListener('resize', updatePosition);
      });
    }
  } else {
    document.removeEventListener('mousedown', handleClickOutside);
    window.removeEventListener('resize', updatePosition);
  }
});

onMounted(() => {
  if (props.isVisible && !props.isMobile) {
    searchTerm.value = ''; 
    document.addEventListener('mousedown', handleClickOutside);
    nextTick(() => { 
      updatePosition();
      window.addEventListener('resize', updatePosition);
    });
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  window.removeEventListener('resize', updatePosition);
});
</script>

<template>
  <div>
    <!-- 移动端贴底抽屉视图 (Bottom Sheet) -->
    <template v-if="isMobile && isVisible">
      <div
        class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex flex-col justify-end select-none"
        @click.self="closeModal"
      >
        <div class="w-full bg-background rounded-t-2xl border-t border-border/80 shadow-2xl p-4 flex flex-col max-h-[80vh] overflow-hidden">
          <!-- 顶部药丸手柄 -->
          <div class="pt-1 pb-2 flex justify-center cursor-pointer" @click="closeModal">
            <div class="w-10 h-1 bg-border/80 rounded-full"></div>
          </div>

          <!-- 顶栏标题 -->
          <div class="flex items-center justify-between pb-3 border-b border-border/40">
            <h3 class="text-base font-semibold text-foreground flex items-center gap-2">
              <i class="fas fa-star text-amber-400"></i>
              <span>{{ t('fileManager.favoritePathsTooltip', '常用路径收藏夹') }}</span>
            </h3>
            <button
              class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header"
              @click="closeModal"
            >
              <i class="fas fa-times text-sm"></i>
            </button>
          </div>

          <!-- 工具栏：搜索与排序/添加按钮 -->
          <div class="py-3 flex items-center gap-2">
            <div class="relative flex-grow">
              <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-xs text-text-secondary pointer-events-none"></i>
              <input
                type="text"
                v-model="searchTerm"
                :placeholder="t('favoritePaths.searchPlaceholder', '搜索名称或路径...')"
                class="w-full h-10 bg-input border border-border rounded-xl pl-8 pr-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
              />
            </div>
            <button
              @click="toggleSort"
              class="w-10 h-10 flex items-center justify-center bg-header/60 border border-border rounded-xl text-text-secondary hover:text-primary active:scale-95 transition-all shrink-0"
              :title="currentSortBy === 'name' ? '按名称排序' : '按时间排序'"
            >
              <i :class="sortButtonIcon"></i>
            </button>
            <button
              @click="openAddModal"
              class="h-10 px-3 flex items-center justify-center gap-1.5 bg-primary text-white rounded-xl text-xs font-semibold active:scale-95 transition-all shadow-md shrink-0"
              :title="t('favoritePaths.addNew', '添加常用路径')"
            >
              <i class="fas fa-plus text-xs"></i>
              <span>添加</span>
            </button>
          </div>

          <!-- 路径列表 -->
          <div class="overflow-y-auto flex-grow space-y-2 py-1 pr-1 overscroll-contain">
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
                  class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-primary active:bg-primary/20 transition-colors"
                  title="在终端切换至此路径"
                >
                  <i class="fas fa-terminal text-xs"></i>
                </button>
                <button
                  @click="openEditModal(favPath)"
                  class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-amber-500 active:bg-amber-500/20 transition-colors"
                  :title="t('common.edit')"
                >
                  <i class="fas fa-pencil-alt text-xs"></i>
                </button>
                <button
                  @click="handleDelete(favPath)"
                  class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-rose-500 active:bg-rose-500/20 transition-colors"
                  :title="t('common.delete')"
                >
                  <i class="fas fa-trash-alt text-xs"></i>
                </button>
              </div>
            </div>
          </div>

          <!-- 底部安全区 -->
          <div class="h-[max(env(safe-area-inset-bottom,0px),8px)]"></div>
        </div>
      </div>
    </template>

    <!-- 桌面端常规绝对定位下拉浮层 -->
    <template v-else>
      <div
        v-if="isVisible"
        ref="modalContentRef"
        :style="modalStyle"
        class="z-50 w-72 md:w-80 rounded-md bg-background shadow-lg border border-border/50 max-h-80 flex flex-col overflow-hidden"
      >
        <!-- Toolbar: Search and Add Button -->
        <div class="p-2 flex-shrink-0 flex items-center gap-2">
          <div class="relative flex-grow">
            <input
              type="text"
              v-model="searchTerm"
              :placeholder="t('favoritePaths.searchPlaceholder', 'Search by name or path...')"
              class="w-full bg-input border border-border rounded-md pl-2.5 pr-2 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
            />
          </div>
          <button
            @click="toggleSort"
            class="flex items-center justify-center w-8 h-8 bg-background border border-border text-text-secondary rounded-lg text-sm cursor-pointer shadow-sm transition-colors duration-200 ease-in-out hover:bg-primary/10 hover:text-primary focus:outline-none flex-shrink-0"
          >
            <i :class="sortButtonIcon"></i>
          </button>
          <button
            @click="openAddModal"
            class="flex items-center justify-center w-8 h-8 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary flex-shrink-0"
            :title="t('favoritePaths.addNew', 'Add new favorite path')"
          >
            <i class="fas fa-plus text-base"></i>
          </button>
        </div>

        <!-- Path List -->
        <div class="overflow-y-auto flex-grow p-1 text-sm">
          <div v-if="favoritePathsStore.isLoading && filteredPaths.length === 0" class="p-3 text-center text-text-secondary">
            <i class="fas fa-spinner fa-spin mr-1"></i>
            {{ t('favoritePaths.loading', 'Loading favorites...') }}
          </div>
          <div v-else-if="!favoritePathsStore.isLoading && filteredPaths.length === 0" class="p-3 text-center text-text-secondary">
            <i class="fas fa-star-half-alt mr-1"></i>
            {{ searchTerm ? t('favoritePaths.noResults', 'No matching favorites found.') : t('favoritePaths.noFavorites', 'No favorite paths yet. Add one!') }}
          </div>
          <ul v-else-if="filteredPaths.length > 0" class="list-none m-0 p-0">
            <li
              v-for="favPath in filteredPaths"
              :key="favPath.id"
              class="p-2 hover:bg-primary/10 cursor-pointer group flex items-center justify-between rounded-md transition-colors duration-150"
              @click="handleItemClick(favPath)"
              :title="favPath.path"
            >
              <div class="flex-grow overflow-hidden mr-2">
                <p class="font-medium truncate text-foreground">
                  {{ favPath.name || favPath.path }}
                </p>
                <p v-if="favPath.name" class="text-xs text-text-secondary truncate">
                  {{ favPath.path }}
                </p>
              </div>
              <div class="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                <button
                  @click.stop="handleSendToTerminal(favPath)"
                  class="p-1.5 rounded text-text-secondary hover:text-primary hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  :title="t('favoritePaths.sendToTerminal', 'Send to Terminal')">
                  <i class="fas fa-terminal text-xs"></i>
                </button>
                <button
                  @click.stop="openEditModal(favPath)"
                  class="p-1.5 rounded text-text-secondary hover:text-primary hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  :title="t('common.edit')">
                  <i class="fas fa-pencil-alt text-xs"></i>
                </button>
                <button
                  @click.stop="handleDelete(favPath)"
                  class="p-1.5 rounded text-text-secondary hover:text-error hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  :title="t('common.delete')">
                  <i class="fas fa-trash-alt text-xs"></i>
                </button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <!-- Add/Edit Modal (传递 isMobile) -->
    <AddEditFavoritePathForm
      v-if="showAddEditModal"
      :is-visible="showAddEditModal"
      :path-data="editingPathItem"
      :is-mobile="isMobile"
      @close="showAddEditModal = false"
      @save-success="() => { favoritePathsStore.fetchFavoritePaths(t); showAddEditModal = false; }"
    />
  </div> 
</template>

<style scoped>
</style>
