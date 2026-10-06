<script setup lang="ts">
import { ref, watch, computed, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';

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
  <div v-if="isVisible" class="fixed inset-0 z-[70]">
    <!-- 移动端贴底抽屉视图 (Bottom Sheet) -->
    <template v-if="isMobile">
      <div
        class="fixed inset-0 bg-black/60 backdrop-blur-xs flex flex-col justify-end select-none"
        @click.self="closeModal"
      >
        <div class="w-full bg-background rounded-t-2xl border-t border-border/80 shadow-2xl p-4 flex flex-col max-h-[85vh] overflow-y-auto">
          <!-- 顶部药丸手柄 -->
          <div class="pt-1 pb-2 flex justify-center cursor-pointer" @click="closeModal">
            <div class="w-10 h-1 bg-border/80 rounded-full"></div>
          </div>

          <!-- 顶栏标题 -->
          <div class="flex items-center justify-between pb-3 border-b border-border/40">
            <h3 class="text-base font-semibold text-foreground flex items-center gap-2">
              <i class="fas fa-star text-amber-400"></i>
              <span>{{ isEditMode ? t('favoritePaths.addEditForm.editTitle', '编辑收藏路径') : t('favoritePaths.addEditForm.addTitle', '添加常用路径') }}</span>
            </h3>
            <button
              class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header"
              @click="closeModal"
            >
              <i class="fas fa-times text-sm"></i>
            </button>
          </div>

          <!-- 表单区 -->
          <form @submit.prevent="handleSubmit" class="space-y-3.5 py-4">
            <div>
              <label for="favPath-mobile-name" class="block text-xs font-medium text-text-secondary mb-1.5">
                {{ t('favoritePaths.addEditForm.nameLabel', '显示名称 (可选)') }}
              </label>
              <input
                id="favPath-mobile-name"
                type="text"
                v-model="form.name"
                :disabled="isLoading"
                class="w-full h-11 px-3.5 bg-input border border-border rounded-xl text-base text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary shadow-xs transition-colors"
                :placeholder="t('favoritePaths.addEditForm.namePlaceholder', '例如：项目根目录、Nginx 配置')"
              />
            </div>

            <div>
              <label for="favPath-mobile-path" class="block text-xs font-medium text-text-secondary mb-1.5">
                {{ t('favoritePaths.addEditForm.pathLabel', '绝对路径') }}
                <span class="text-rose-500 ml-0.5">*</span>
              </label>
              <input
                id="favPath-mobile-path"
                type="text"
                v-model="form.path"
                required
                :disabled="isLoading"
                class="w-full h-11 px-3.5 bg-input border border-border rounded-xl text-base font-mono text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary shadow-xs transition-colors"
                :placeholder="t('favoritePaths.addEditForm.pathPlaceholder', '/var/www/html 或 /root/data')"
              />
            </div>

            <div v-if="errorMessage" class="text-rose-500 text-xs p-2.5 bg-rose-500/10 border border-rose-500/20 rounded-xl">
              {{ errorMessage }}
            </div>
          </form>

          <!-- 底部双大按钮 -->
          <div class="flex items-center gap-3 pt-2">
            <button
              type="button"
              @click="closeModal"
              :disabled="isLoading"
              class="flex-1 h-11 rounded-xl bg-header/60 border border-border/80 text-foreground font-medium text-sm active:scale-95 transition-transform"
            >
              {{ t('common.cancel', '取消') }}
            </button>
            <button
              type="button"
              @click="handleSubmit"
              :disabled="isLoading || !form.path.trim()"
              class="flex-1 h-11 rounded-xl bg-primary text-white font-medium text-sm active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {{ isLoading ? t('common.saving', '保存中...') : t('common.save', '保存') }}
            </button>
          </div>

          <!-- 底部安全区 -->
          <div class="h-[max(env(safe-area-inset-bottom,0px),8px)]"></div>
        </div>
      </div>
    </template>

    <!-- 桌面端常规居中弹窗 -->
    <template v-else>
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
    </template>
  </div>
</template>

<style scoped>
</style>