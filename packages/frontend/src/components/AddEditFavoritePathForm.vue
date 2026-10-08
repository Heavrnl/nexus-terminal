<script setup lang="ts">
import { ref, watch, computed, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';
import MobileAddEditFavoritePathForm from './MobileAddEditFavoritePathForm.vue';

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  pathData: {
    type: Object as PropType<FavoritePathItem | null>,
    default: null,
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['close', 'saveSuccess']);

const { t } = useI18n();
const favoritePathsStore = useFavoritePathsStore();

const form = ref({
  id: '',
  path: '',
  name: '',
});

const isEditMode = computed(() => !props.pathData?.id);
const isLoading = ref(false);
const errorMessage = ref<string | null>(null);

watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    errorMessage.value = null;
    if (props.pathData) {
      form.value = { 
        id: props.pathData.id, 
        path: props.pathData.path, 
        name: props.pathData.name || '' 
      };
    } else {
      form.value = { id: '', path: '', name: '' };
    }
  }
}, { immediate: true });

const validateForm = (): boolean => {
  if (!form.value.path.trim()) {
    errorMessage.value = t('favoritePaths.addEditForm.validation.pathRequired', '请输入有效路径');
    return false;
  }
  errorMessage.value = null;
  return true;
};

const handleSubmit = async () => {
  if (!validateForm()) {
    return;
  }
  isLoading.value = true;
  errorMessage.value = null;
  try {
    if (isEditMode.value && form.value.id) {
      await favoritePathsStore.updateFavoritePath(form.value.id, {
        path: form.value.path,
        name: form.value.name || undefined,
      }, t);
    } else {
      await favoritePathsStore.addFavoritePath({
        path: form.value.path,
        name: form.value.name || undefined,
      }, t);
    }
    emit('saveSuccess');
    closeModal();
  } catch (error: any) {
    console.error('Error saving favorite path:', error);
    errorMessage.value = error.message || t('favoritePaths.addEditForm.errors.genericSaveError', '保存常用路径失败');
  } finally {
    isLoading.value = false;
  }
};

const closeModal = () => {
  if (!isLoading.value) {
    emit('close');
  }
};
</script>

<template>
  <!-- 移动端专属弹窗抽屉 -->
  <MobileAddEditFavoritePathForm
    v-if="isMobile"
    :is-visible="isVisible"
    :path-data="pathData"
    @close="closeModal"
    @save-success="emit('saveSuccess')"
  />

  <!-- 桌面端常规居中弹窗 -->
  <div v-else-if="isVisible" class="fixed inset-0 z-[70]">
    <div 
      class="fixed inset-0 flex items-center justify-center bg-[var(--overlay-bg-color)]"
      @click.self="closeModal"
    >
      <div class="bg-background text-foreground shadow-xl rounded-lg w-full max-w-md flex flex-col overflow-hidden m-4 p-6">
        <!-- Header -->
        <h2 class="m-0 mb-6 text-center text-xl font-semibold">
          {{ isEditMode ? t('favoritePaths.addEditForm.editTitle', 'Edit Favorite Path') : t('favoritePaths.addEditForm.addTitle', 'Add New Favorite Path') }}
        </h2>

        <!-- Form Body -->
        <form @submit.prevent="handleSubmit" class="space-y-4 flex-grow overflow-y-auto">
          <div>
            <label for="favPath-name" class="block text-sm font-medium text-text-secondary mb-1">
              {{ t('favoritePaths.addEditForm.nameLabel', 'Name (Optional)') }}
            </label>
            <input
              id="favPath-name"
              type="text"
              v-model="form.name"
              :disabled="isLoading"
              class="w-full bg-input border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
              :placeholder="t('favoritePaths.addEditForm.namePlaceholder', 'My Documents')"
            />
          </div>
          <div>
            <label for="favPath-path" class="block text-sm font-medium text-text-secondary mb-1">
              {{ t('favoritePaths.addEditForm.pathLabel', 'Path') }}
              <span class="text-rose-500 ml-0.5">*</span>
            </label>
            <input
              id="favPath-path"
              type="text"
              v-model="form.path"
              required
              :disabled="isLoading"
              class="w-full bg-input border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
              :placeholder="t('favoritePaths.addEditForm.pathPlaceholder', '/example/folder/path')"
            />
          </div>

          <div v-if="errorMessage" class="text-rose-500 text-sm p-2 bg-rose-500/10 rounded-md">
            {{ errorMessage }}
          </div>
        </form>

        <!-- Footer -->
        <div class="flex justify-end mt-8 pt-4 border-t border-border/50">
          <button
            type="button"
            @click="closeModal"
            :disabled="isLoading"
            class="py-2 px-5 rounded-lg text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground mr-3">
            {{ t('common.cancel', 'Cancel') }}
          </button>
          <button
            type="submit"
            @click="handleSubmit"
            :disabled="isLoading || !form.path.trim()"
            class="py-2 px-5 rounded-lg text-sm font-semibold transition-colors duration-150 bg-primary text-white border-none shadow-md hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed">
            {{ isLoading ? t('common.saving', 'Saving...') : t('common.save', 'Save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>