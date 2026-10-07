<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfirmDialog } from '../composables/useConfirmDialog';

interface GenericTag {
  id: number;
  name: string;
}

const props = defineProps<{
  modelValue: number[];
  availableTags?: GenericTag[];
  placeholder?: string;
  allowCreate?: boolean;
  allowDelete?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: number[]): void;
  (e: 'create-tag', tagName: string): void;
  (e: 'delete-tag', tagId: number): void;
}>();

const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();

const newTagName = ref('');
const isInputActive = ref(false);

const availableTagsList = computed(() => props.availableTags ?? []);
const allowCreateTag = computed(() => props.allowCreate !== false);
const allowDeleteTag = computed(() => props.allowDelete !== false);

// 标签映射字典
const tagsMap = computed(() => {
  const map = new Map<number, GenericTag>();
  availableTagsList.value.forEach(tag => map.set(tag.id, tag));
  return map;
});

// 当前已选中的标签列表
const selectedTags = computed(() => {
  return (props.modelValue || [])
    .map(id => tagsMap.value.get(id))
    .filter((tag): tag is GenericTag => tag !== undefined);
});

// 未选中的可用标签列表 (供快速点选)
const unselectedTags = computed(() => {
  const selectedSet = new Set(props.modelValue || []);
  return availableTagsList.value.filter(tag => !selectedSet.has(tag.id));
});

// 快速切换选中/取消选中
const toggleTag = (tagId: number) => {
  const current = [...(props.modelValue || [])];
  const index = current.indexOf(tagId);
  if (index >= 0) {
    current.splice(index, 1);
  } else {
    current.push(tagId);
  }
  emit('update:modelValue', current);
};

// 移除已选中的标签
const removeSelectedTag = (tagId: number) => {
  const current = (props.modelValue || []).filter(id => id !== tagId);
  emit('update:modelValue', current);
};

// 创建新标签并自动选中
const handleCreateNewTag = () => {
  const trimmed = newTagName.value.trim();
  if (!trimmed) return;

  // 检查是否已经存在同名标签
  const existing = availableTagsList.value.find(
    tag => tag.name.toLowerCase() === trimmed.toLowerCase()
  );

  if (existing) {
    // 若已存在但未选中，则选中
    if (!(props.modelValue || []).includes(existing.id)) {
      emit('update:modelValue', [...(props.modelValue || []), existing.id]);
    }
  } else if (allowCreateTag.value) {
    emit('create-tag', trimmed);
  }

  newTagName.value = '';
  isInputActive.value = false;
};

// 全局删除标签 (危险操作，带确认保护)
const handleDeleteTagGlobally = async (tag: GenericTag) => {
  const confirmed = await showConfirmDialog({
    message: t('tags.deleteConfirm', { name: tag.name }, `确定要全局删除标签“${tag.name}”吗？`)
  });
  if (confirmed) {
    emit('delete-tag', tag.id);
  }
};
</script>

<template>
  <div class="mobile-tag-input space-y-2.5">
    <!-- 1. 已选中标签药丸流 -->
    <div class="min-h-[2.5rem] p-2 bg-header/20 border border-border/60 rounded-xl flex flex-wrap items-center gap-1.5">
      <template v-if="selectedTags.length > 0">
        <span
          v-for="tag in selectedTags"
          :key="tag.id"
          class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground shadow-2xs transition-all"
        >
          <span>{{ tag.name }}</span>
          <button
            type="button"
            @click.stop="removeSelectedTag(tag.id)"
            class="w-4 h-4 rounded-full flex items-center justify-center hover:bg-black/20 active:scale-90 text-[11px] cursor-pointer"
            :title="t('tags.removeSelection', '移除选中')"
          >
            <i class="fas fa-times"></i>
          </button>
        </span>
      </template>
      <span v-else class="text-xs text-text-secondary/60 px-1 py-0.5 select-none">
        {{ props.placeholder || t('tags.inputPlaceholder', '暂未选择标签，轻点下方可选标签即可添加') }}
      </span>
    </div>

    <!-- 2. 可选标签池 (快捷点选，彻底解决打字繁琐问题) -->
    <div v-if="unselectedTags.length > 0" class="space-y-1.5">
      <div class="text-[11px] text-text-secondary/70 flex items-center justify-between">
        <span>快捷点选已有标签：</span>
        <span>共 {{ availableTagsList.length }} 个</span>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 max-h-28 overflow-y-auto pr-0.5">
        <button
          v-for="tag in unselectedTags"
          :key="tag.id"
          type="button"
          @click="toggleTag(tag.id)"
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-background border border-border/70 text-text-secondary hover:text-foreground active:scale-95 transition-all cursor-pointer shadow-2xs"
        >
          <i class="fas fa-plus text-[10px] text-primary/70"></i>
          <span>{{ tag.name }}</span>

          <!-- 全局删除标签小图标 (仅当开启 allowDelete 时显示) -->
          <button
            v-if="allowDeleteTag"
            type="button"
            @click.stop="handleDeleteTagGlobally(tag)"
            class="ml-0.5 text-text-secondary/40 hover:text-red-400 p-0.5 text-[10px] cursor-pointer"
            :title="t('tags.deleteTagGlobally', '删除此标签')"
          >
            <i class="fas fa-trash-alt"></i>
          </button>
        </button>
      </div>
    </div>

    <!-- 3. 新建标签输入栏 -->
    <div v-if="allowCreateTag" class="flex items-center gap-1.5 pt-1">
      <div class="relative flex-grow">
        <input
          type="text"
          v-model="newTagName"
          placeholder="输入新标签名并点击添加..."
          @focus="isInputActive = true"
          @keydown.enter.prevent="handleCreateNewTag"
          class="w-full h-8.5 px-3 text-xs bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
        />
        <button
          v-if="newTagName"
          type="button"
          @click="newTagName = ''"
          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary/60 text-xs p-1"
        >
          <i class="fas fa-times-circle"></i>
        </button>
      </div>

      <button
        type="button"
        @click="handleCreateNewTag"
        :disabled="!newTagName.trim()"
        class="h-8.5 px-3 rounded-xl bg-primary text-primary-foreground font-semibold text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-95 transition-all shrink-0 flex items-center gap-1 cursor-pointer"
      >
        <i class="fas fa-plus text-xs"></i>
        <span>添加标签</span>
      </button>
    </div>
  </div>
</template>
