<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';
import AddEditFavoritePathForm from './AddEditFavoritePathForm.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import MobileFavoritePathsModal from './MobileFavoritePathsModal.vue';

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

const closeModal = () => {
  emit('close');
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

const updatePosition = () => {
  if (props.isMobile) return;
  if (!props.triggerElement || !modalContentRef.value) return;

  const triggerRect = props.triggerElement.getBoundingClientRect();
  const modalRect = modalContentRef.value.getBoundingClientRect();

  let top = triggerRect.bottom + PADDING;
  let left = triggerRect.left;

  if (top + modalRect.height > window.innerHeight - PADDING) {
    top = triggerRect.top - modalRect.height - PADDING;
    if (top < PADDING) {
      top = window.innerHeight - modalRect.height - PADDING;
    }
  }

  if (left + modalRect.width > window.innerWidth - PADDING) {
    left = window.innerWidth - modalRect.width - PADDING;
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
  <!-- 移动端：委托给专门的 MobileFavoritePathsModal -->
  <MobileFavoritePathsModal
    v-if="props.isMobile"
    :is-visible="props.isVisible"
    @close="closeModal"
    @navigate-to-path="(p: string) => emit('navigateToPath', p)"
  />

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
          {{ t('favoritePaths.loading', 'Loading favorite paths...') }}
        </div>
        <div v-else-if="!favoritePathsStore.isLoading && filteredPaths.length === 0" class="p-3 text-center text-text-secondary">
          {{ searchTerm ? t('favoritePaths.noResults', 'No matching paths found') : t('favoritePaths.noFavorites', 'No favorite paths yet. Add one!') }}
        </div>
        <div
          v-else
          v-for="favPath in filteredPaths"
          :key="favPath.id"
          class="group flex items-center justify-between p-1.5 rounded hover:bg-primary/10 cursor-pointer"
          @click="handleItemClick(favPath)"
        >
          <div class="truncate flex-grow mr-2">
            <span v-if="favPath.name" class="font-medium text-foreground block truncate">{{ favPath.name }}</span>
            <span class="text-xs text-text-secondary block truncate" :class="{ 'font-medium text-foreground': !favPath.name }">{{ favPath.path }}</span>
          </div>
          <div class="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              @click.stop="openEditModal(favPath)"
              class="p-1 text-text-secondary hover:text-primary rounded"
              :title="t('common.edit')"
            >
              <i class="fas fa-edit text-xs"></i>
            </button>
            <button
              @click.stop="handleDelete(favPath)"
              class="p-1 text-text-secondary hover:text-red-500 rounded"
              :title="t('common.delete')"
            >
              <i class="fas fa-trash-alt text-xs"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add/Edit Modal (Desktop) -->
    <AddEditFavoritePathForm
      :is-visible="showAddEditModal"
      :path-item="editingPathItem"
      :is-mobile="false"
      @close="showAddEditModal = false"
    />
  </template>
</template>
