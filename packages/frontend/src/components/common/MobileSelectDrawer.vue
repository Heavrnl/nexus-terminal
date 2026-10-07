<script setup lang="ts">
import { ref, computed } from 'vue';

export interface MobileSelectOption {
  value: any;
  label: string;
  sublabel?: string;
  badge?: string;
  icon?: string;
}

const props = withDefaults(defineProps<{
  modelValue: any;
  options: MobileSelectOption[];
  title?: string;
  placeholder?: string;
  disabled?: boolean;
  icon?: string;
  allowClear?: boolean;
}>(), {
  title: '请选择',
  placeholder: '点击进行选择...',
  disabled: false,
  icon: '',
  allowClear: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: any): void;
  (e: 'change', value: any): void;
}>();

const isOpen = ref(false);
const searchQuery = ref('');

// 当前选中的选项对象
const selectedOption = computed(() => {
  return props.options.find(opt => opt.value === props.modelValue);
});

// 过滤后的选项列表
const filteredOptions = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return props.options;
  return props.options.filter(opt => {
    const labelMatch = opt.label?.toLowerCase().includes(query);
    const subMatch = opt.sublabel?.toLowerCase().includes(query);
    const badgeMatch = opt.badge?.toLowerCase().includes(query);
    return labelMatch || subMatch || badgeMatch;
  });
});

const openDrawer = () => {
  if (props.disabled) return;
  searchQuery.value = '';
  isOpen.value = true;
};

const closeDrawer = () => {
  isOpen.value = false;
};

const handleSelect = (option: MobileSelectOption) => {
  emit('update:modelValue', option.value);
  emit('change', option.value);
  closeDrawer();
};

const handleClear = () => {
  emit('update:modelValue', null);
  emit('change', null);
  closeDrawer();
};
</script>

<template>
  <div class="mobile-select-container w-full">
    <!-- 1. 触发卡片按钮 (Trigger) -->
    <button
      type="button"
      @click="openDrawer"
      :disabled="props.disabled"
      class="w-full h-10 px-3 bg-header/20 border border-border/60 rounded-xl text-left flex items-center justify-between gap-2 transition-all cursor-pointer select-none active:bg-header/40 disabled:opacity-50 disabled:cursor-not-allowed"
      :class="isOpen ? 'ring-1 ring-primary border-primary' : ''"
    >
      <div class="flex items-center gap-2 min-w-0">
        <i v-if="props.icon" :class="[props.icon, 'text-xs text-text-secondary/70 shrink-0']"></i>
        <div v-if="selectedOption" class="flex items-center gap-1.5 min-w-0">
          <span class="text-xs font-medium text-foreground truncate">
            {{ selectedOption.label }}
          </span>
          <span
            v-if="selectedOption.badge"
            class="px-1.5 py-0.2 rounded text-[10px] uppercase font-mono font-bold bg-primary/10 text-primary border border-primary/20 shrink-0"
          >
            {{ selectedOption.badge }}
          </span>
        </div>
        <span v-else class="text-xs text-text-secondary/50 truncate">
          {{ props.placeholder }}
        </span>
      </div>

      <div class="flex items-center gap-1.5 text-text-secondary/60 shrink-0">
        <i class="fas fa-chevron-down text-xs transition-transform duration-200" :class="isOpen ? 'rotate-180' : ''"></i>
      </div>
    </button>

    <!-- 2. 底部选择抽屉 (Bottom Sheet) -->
    <Teleport to="body">
      <Transition name="mobile-select-fade">
        <div
          v-if="isOpen"
          class="fixed inset-0 z-[60] flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
          @click.self="closeDrawer"
        >
          <div
            class="mobile-select-sheet w-full max-h-[75vh] flex flex-col bg-background border-t border-border/50 rounded-t-2xl shadow-2xl overflow-hidden select-text"
          >
            <!-- 抽屉吸顶顶栏 -->
            <div class="shrink-0 pt-2.5 pb-2.5 px-4 border-b border-border/40 bg-header/40 select-none">
              <!-- 顶部手柄条 -->
              <div class="w-10 h-1 bg-border/80 rounded-full mx-auto mb-2 cursor-pointer" @click="closeDrawer"></div>

              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-foreground tracking-tight">
                  {{ props.title }}
                </span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="props.allowClear && props.modelValue !== null"
                    type="button"
                    @click="handleClear"
                    class="text-xs text-text-secondary hover:text-red-400 px-2 py-0.5 cursor-pointer"
                  >
                    清空选择
                  </button>
                  <button
                    type="button"
                    @click="closeDrawer"
                    class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-border/30 cursor-pointer text-xs"
                  >
                    <i class="fas fa-times"></i>
                  </button>
                </div>
              </div>
            </div>

            <!-- 搜索框 (选项 > 5 时启用) -->
            <div v-if="props.options.length > 5" class="p-3 border-b border-border/30 bg-header/10 shrink-0">
              <div class="relative">
                <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-xs text-text-secondary/60"></i>
                <input
                  type="text"
                  v-model="searchQuery"
                  placeholder="搜索选项..."
                  class="w-full h-8.5 pl-8 pr-3 text-xs bg-header/30 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <!-- 选项卡片滚动列表 -->
            <div class="flex-grow overflow-y-auto p-3 space-y-1.5 overscroll-contain pb-[env(safe-area-inset-bottom,20px)]">
              <div v-if="filteredOptions.length === 0" class="py-10 text-center text-xs text-text-secondary/70">
                无匹配选项
              </div>

              <button
                v-for="opt in filteredOptions"
                :key="String(opt.value)"
                type="button"
                @click="handleSelect(opt)"
                class="w-full p-3 rounded-xl border text-left flex items-center justify-between gap-3 transition-all cursor-pointer active:scale-99"
                :class="opt.value === props.modelValue
                  ? 'bg-primary/10 border-primary/50 text-foreground shadow-2xs'
                  : 'bg-background/80 border-border/50 text-foreground hover:bg-header/40'"
              >
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <i v-if="opt.icon" :class="[opt.icon, 'text-xs text-primary']"></i>
                    <span class="text-xs font-semibold truncate">{{ opt.label }}</span>
                    <span
                      v-if="opt.badge"
                      class="px-1.5 py-0.2 rounded text-[10px] uppercase font-mono font-bold bg-header border border-border/60 text-text-secondary"
                    >
                      {{ opt.badge }}
                    </span>
                  </div>
                  <div v-if="opt.sublabel" class="text-[11px] text-text-secondary/80 mt-0.5 truncate">
                    {{ opt.sublabel }}
                  </div>
                </div>

                <div class="shrink-0">
                  <div
                    class="w-5 h-5 rounded-full flex items-center justify-center text-xs transition-colors"
                    :class="opt.value === props.modelValue ? 'bg-primary text-primary-foreground' : 'border border-border/60 text-transparent'"
                  >
                    <i class="fas fa-check text-[10px]"></i>
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.mobile-select-fade-enter-active,
.mobile-select-fade-leave-active {
  transition: opacity 0.2s ease;
}
.mobile-select-fade-enter-from,
.mobile-select-fade-leave-to {
  opacity: 0;
}
.mobile-select-fade-enter-active .mobile-select-sheet {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.mobile-select-fade-leave-active .mobile-select-sheet {
  transition: transform 0.2s cubic-bezier(0.4, 0, 1, 1);
}
.mobile-select-fade-enter-from .mobile-select-sheet,
.mobile-select-fade-leave-to .mobile-select-sheet {
  transform: translateY(100%);
}
</style>
