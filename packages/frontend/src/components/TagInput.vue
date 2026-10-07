<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
// import { storeToRefs } from 'pinia'; // No longer needed directly
import { useI18n } from 'vue-i18n';
// import { useTagsStore, TagInfo } from '../stores/tags.store'; // REMOVE dependency on specific store

// Define a generic tag structure for the prop
interface GenericTag {
  id: number;
  name: string;
}

const props = defineProps<{
    modelValue: number[]; // 接收选中的 tag_ids
    availableTags?: GenericTag[]; // Optional: The list of tags to choose from/display
    placeholder?: string; // Optional: Placeholder for the input
    allowCreate?: boolean; // Optional: Allow creating new tags via Enter (default true)
    allowDelete?: boolean; // Optional: Allow showing the global delete button (default true)
}>();

const emit = defineEmits(['update:modelValue', 'create-tag', 'delete-tag']);

const { t } = useI18n();
import { useDeviceDetection } from '../composables/useDeviceDetection';
import MobileTagInput from './MobileTagInput.vue';

const { isMobile } = useDeviceDetection();

const inputValue = ref(''); // 输入框的值
const inputRef = ref<HTMLInputElement | null>(null); // 输入框引用
const showSuggestions = ref(false); // 是否显示建议列表
const selectedTagIds = ref<number[]>([]); // 本地维护选中的 tag_ids

// Default values for props
const availableTags = computed(() => props.availableTags ?? []);
const placeholder = computed(() => props.placeholder ?? t('tags.inputPlaceholder', '添加或选择标签...'));
const allowCreate = computed(() => props.allowCreate !== false); // Default true
const allowDelete = computed(() => props.allowDelete !== false); // Default true

// 监听 props.modelValue 的变化，同步到本地 selectedTagIds
watch(() => props.modelValue, (newVal) => {
  // 只有在值确实不同的情况下才更新，避免无限循环
  if (JSON.stringify(newVal.sort()) !== JSON.stringify(selectedTagIds.value.sort())) {
    selectedTagIds.value = [...newVal];
  }
}, { immediate: true, deep: true });

// 监听本地 selectedTagIds 的变化，通知父组件
watch(selectedTagIds, (newVal) => {
  // 只有在值确实不同的情况下才更新，避免无限循环
  if (JSON.stringify(newVal.sort()) !== JSON.stringify(props.modelValue.sort())) {
    emit('update:modelValue', [...newVal]);
  }
}, { deep: true });


// 计算属性：所有标签的 Map，方便通过 ID 查找
// Use availableTags prop for the map
const tagsMap = computed(() => {
    const map = new Map<number, GenericTag>();
    availableTags.value.forEach(tag => map.set(tag.id, tag));
    return map;
});

// 计算属性：已选中的标签对象
const selectedTags = computed(() => {
  // 确保先从 map 中查找，再过滤掉未找到的 (可能标签已被删除)
  return selectedTagIds.value
    .map(id => tagsMap.value.get(id)) // Get from the map based on prop
    .filter((tag): tag is GenericTag => tag !== undefined);
});

// 计算属性：过滤后的建议列表 (based on availableTags)
const suggestions = computed(() => {
  if (!showSuggestions.value) { // 仅在需要显示时计算
    return [];
  }
  let result: GenericTag[]; // Use GenericTag type
  // Use availableTags from prop
  const currentAvailableTags = availableTags.value;
  // 如果输入框为空，显示所有未选中的可用标签
  if (!inputValue.value) {
      result = currentAvailableTags.filter(tag => !selectedTagIds.value.includes(tag.id));
  } else {
      const lowerCaseInput = inputValue.value.toLowerCase();
      result = currentAvailableTags.filter(tag =>
          tag.name.toLowerCase().includes(lowerCaseInput) &&
          !selectedTagIds.value.includes(tag.id) // 排除已选中的
      );
  }
  return result;
});

// 处理输入框聚焦 (不再 fetch, 仅根据现有 availableTags 判断是否显示)
const handleFocus = () => {
    // 计算建议 (不依赖 showSuggestions ref)
    let potentialSuggestions: GenericTag[];
    const currentInput = inputValue.value;
    const currentAvailableTags = availableTags.value.filter(tag => !selectedTagIds.value.includes(tag.id));

    if (!currentInput) {
        potentialSuggestions = currentAvailableTags;
    } else {
        const lowerCaseInput = currentInput.toLowerCase();
        potentialSuggestions = currentAvailableTags.filter(tag =>
            tag.name.toLowerCase().includes(lowerCaseInput)
        );
    }
    // 只有当确实存在潜在建议时，才显示建议列表
    showSuggestions.value = potentialSuggestions.length > 0;
};

// 处理输入框失焦
const handleBlur = () => {
  // 立即隐藏菜单，无需延迟
  showSuggestions.value = false;
};

// 处理键盘事件 (Enter 创建, Backspace 删除)
const handleKeyDown = async (event: KeyboardEvent) => {
  if (event.key === 'Enter' && inputValue.value.trim()) {
    event.preventDefault(); // 阻止表单提交等默认行为
    const trimmedInput = inputValue.value.trim();
    const lowerCaseInput = trimmedInput.toLowerCase();
    // Check against availableTags prop
    const existingTag = availableTags.value.find(tag => tag.name.toLowerCase() === lowerCaseInput);

    if (existingTag && !selectedTagIds.value.includes(existingTag.id)) {
        // 如果是现有标签且未选中，则选中它
        selectTag(existingTag);
    } else if (!existingTag && allowCreate.value) { // Only create if allowed and not existing
        // 如果是新标签，则 emit 事件让父组件处理创建
        console.log(`[TagInput] Emitting create-tag for: ${trimmedInput}`); 
        emit('create-tag', trimmedInput);
        // 父组件负责创建、更新 availableTags prop，然后 TagInput 会响应式更新
        // 父组件也负责将新创建的 tag ID 添加到 modelValue
    }
    inputValue.value = ''; // 清空输入框
    showSuggestions.value = false; // 创建或选择后隐藏建议
  } else if (event.key === 'Backspace' && !inputValue.value && selectedTagIds.value.length > 0) {
    // 如果输入框为空且按了退格键，则移除最后一个选中的标签 (仅从当前选择移除)
    removeTagLocally(selectedTags.value[selectedTags.value.length - 1]);
  }
};

// 选中一个标签 (来自建议列表或 Enter 匹配)
const selectTag = (tag: GenericTag) => {
    if (!selectedTagIds.value.includes(tag.id)) {
        // 使用 .push() 来触发 watch -> emit update:modelValue
        selectedTagIds.value = [...selectedTagIds.value, tag.id];
  }
  inputValue.value = ''; // 清空输入框
  showSuggestions.value = false; // 选择后隐藏建议
  inputRef.value?.focus(); // 重新聚焦输入框
};

// 仅从本地选择中移除一个标签 (点击选中标签的 'x' 或 Backspace)
const removeTagLocally = (tagToRemove: GenericTag) => {
    // This will trigger the watch and emit update:modelValue
    selectedTagIds.value = selectedTagIds.value.filter(id => id !== tagToRemove.id);
};

// 处理全局删除标签 (点击标签上的 'x' 图标) - Emit event
const handleDeleteTagGlobally = (tagToDelete: GenericTag) => {
    console.log(`[TagInput] handleDeleteTagGlobally called for tag ID: ${tagToDelete.id}, Name: ${tagToDelete.name}`); 
    // Emit event for parent to handle deletion confirmation and API call
    console.log(`[TagInput] Emitting delete-tag with ID: ${tagToDelete.id}`); 
    emit('delete-tag', tagToDelete.id);
    // Parent should handle confirmation, call store action, and update modelValue/availableTags
    // We might still want to remove it locally immediately for better UX,
    // but relying on parent updating modelValue is cleaner.
    // removeTagLocally(tagToDelete); // Optional: remove locally immediately
}; // Remove the extra closing brace here if it exists, ensure function closes correctly

</script>

<template>
  <MobileTagInput
    v-if="isMobile"
    :model-value="props.modelValue"
    :available-tags="props.availableTags"
    :placeholder="props.placeholder"
    :allow-create="props.allowCreate"
    :allow-delete="props.allowDelete"
    @update:model-value="emit('update:modelValue', $event)"
    @create-tag="emit('create-tag', $event)"
    @delete-tag="emit('delete-tag', $event)"
  />
  <div v-else class="relative w-full">
    <div class="flex flex-wrap items-center gap-1 p-1.5 border border-border rounded cursor-text bg-background" @click="inputRef?.focus()">
       <div class="inline-flex flex-wrap gap-1">
          <span v-for="tag in selectedTags" :key="tag.id" class="inline-flex items-center bg-background-alt text-foreground text-sm px-2 py-0.5 rounded whitespace-nowrap border border-border">
            {{ tag.name }}
            <button
              type="button"
              class="ml-1.5 p-0 bg-transparent border-none cursor-pointer text-text-secondary hover:text-foreground text-lg leading-none"
              @click.stop="removeTagLocally(tag)"
              :title="t('tags.removeSelection')"
            >&times;</button>
            <!-- Only show delete button if allowDelete is true -->
            <button
                v-if="allowDelete"
                type="button"
                class="ml-1 p-0 bg-transparent border-none cursor-pointer text-text-alt hover:text-error text-xs leading-none"
                @click.stop="handleDeleteTagGlobally(tag)"
                :title="t('tags.deleteTagGlobally')"
            >
                <i class="fas fa-trash-alt"></i>
            </button>
          </span>
       </div>
      <input
        ref="inputRef"
        type="text"
        class="flex-grow border-none outline-none p-0.5 text-sm min-w-[100px] bg-transparent"
        v-model="inputValue"
        :placeholder="t('tags.inputPlaceholder')"
        @focus="handleFocus"
        @blur="handleBlur"
        @keydown="handleKeyDown"
        autocomplete="off"
      />
    </div>
    <ul v-if="showSuggestions && suggestions.length > 0" class="absolute top-full left-0 right-0 mt-0.5 bg-background border border-border rounded-b shadow-md list-none p-0 m-0 max-h-[150px] overflow-y-auto z-10">
      <li
        v-for="suggestion in suggestions"
        :key="suggestion.id"
        class="px-3 py-1.5 cursor-pointer hover:bg-hover text-sm"
        @mousedown.prevent="selectTag(suggestion)"
      >
        {{ suggestion.name }}
      </li>
  </ul>
  <!-- Remove isLoading and error display as they are no longer managed here -->
  <!-- <div v-if="isLoading" ...></div> -->
  <!-- <div v-if="error" ...></div> -->
  </div>
</template>

