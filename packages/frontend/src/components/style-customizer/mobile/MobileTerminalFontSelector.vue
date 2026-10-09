<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import MobileBottomSheet from '../../common/MobileBottomSheet.vue';
import {
  TERMINAL_FONT_PRESETS,
  TERMINAL_FONT_CATEGORIES,
  TerminalFontOption,
  cleanFontName,
  findMatchingPreset,
  isFontAvailableInBrowser,
} from '../../../constants/terminalFonts';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    customFonts?: string[];
    zIndex?: number;
  }>(),
  {
    modelValue: '',
    customFonts: () => [],
    zIndex: 1050,
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'select', value: string): void;
  (e: 'add-custom', fontName: string): void;
  (e: 'remove-custom', fontName: string): void;
}>();

const { t } = useI18n();

// 抽屉显隐状态
const isDrawerVisible = ref(false);

// 搜索关键词
const searchQuery = ref('');

// 当前选中的分类过滤器：'all' | 'recommended' | 'system' | 'cjk' | 'generic' | 'custom'
const activeCategoryFilter = ref<string>('all');

// 自定义字体输入框状态
const isAddingCustomFont = ref(false);
const newCustomFontInput = ref('');

// 打开与关闭抽屉
const openDrawer = () => {
  searchQuery.value = '';
  isAddingCustomFont.value = false;
  newCustomFontInput.value = '';
  isDrawerVisible.value = true;
};

const closeDrawer = () => {
  isDrawerVisible.value = false;
};

// 当前选中的预设匹配信息
const currentMatchedPreset = computed(() => {
  return findMatchingPreset(props.modelValue);
});

// 当前展示的主字体名称
const displayFontTitle = computed(() => {
  if (currentMatchedPreset.value) {
    return currentMatchedPreset.value.name;
  }
  const clean = cleanFontName(props.modelValue);
  return clean || '系统默认等宽 (monospace)';
});

// 分类过滤器选项列表
const categoryFilters = computed(() => {
  const list = [
    { key: 'all', label: '全部', icon: 'fas fa-layer-group', count: TERMINAL_FONT_PRESETS.length + (props.customFonts?.length || 0) },
    ...TERMINAL_FONT_CATEGORIES.map(cat => ({
      key: cat.key,
      label: cat.label.replace(/^[^\s]+\s*/, ''), // 去掉 emoji 前缀便于药丸标签展示
      emoji: cat.label.split(' ')[0],
      count: TERMINAL_FONT_PRESETS.filter(p => p.category === cat.key).length,
    })),
  ];

  if (props.customFonts && props.customFonts.length > 0) {
    list.push({
      key: 'custom',
      label: '自定义',
      icon: 'fas fa-pen-nib',
      count: props.customFonts.length,
    });
  }

  return list;
});

// 过滤后的内置预设列表
const filteredPresets = computed(() => {
  let list = TERMINAL_FONT_PRESETS;

  // 1. 分类过滤
  if (activeCategoryFilter.value !== 'all' && activeCategoryFilter.value !== 'custom') {
    list = list.filter(item => item.category === activeCategoryFilter.value);
  } else if (activeCategoryFilter.value === 'custom') {
    return [];
  }

  // 2. 搜索过滤
  const q = searchQuery.value.trim().toLowerCase();
  if (q) {
    list = list.filter(
      item =>
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.value.toLowerCase().includes(q)
    );
  }

  return list;
});

// 过滤后的自定义字体列表
const filteredCustomFonts = computed(() => {
  if (!props.customFonts || props.customFonts.length === 0) return [];
  if (activeCategoryFilter.value !== 'all' && activeCategoryFilter.value !== 'custom') {
    return [];
  }

  const q = searchQuery.value.trim().toLowerCase();
  if (q) {
    return props.customFonts.filter(f => f.toLowerCase().includes(q));
  }
  return props.customFonts;
});

// 检查某个预设是否当前正处于选中状态
const isPresetSelected = (preset: TerminalFontOption) => {
  if (currentMatchedPreset.value?.id === preset.id) return true;
  return props.modelValue.trim().toLowerCase() === preset.value.trim().toLowerCase();
};

// 检查某个自定义字体是否当前选中
const isCustomFontSelected = (fontValue: string) => {
  return props.modelValue.trim().toLowerCase() === fontValue.trim().toLowerCase();
};

// 选择预设字体
const handleSelectFont = (fontValue: string) => {
  emit('update:modelValue', fontValue);
  emit('select', fontValue);
  closeDrawer();
};

// 提交新增自定义字体
const handleAddCustomFont = () => {
  const font = newCustomFontInput.value.trim();
  if (!font) return;
  emit('add-custom', font);
  handleSelectFont(font);
  newCustomFontInput.value = '';
  isAddingCustomFont.value = false;
};

// 删除自定义字体
const handleRemoveCustomFont = (font: string, e: Event) => {
  e.stopPropagation();
  emit('remove-custom', font);
};
</script>

<template>
  <div class="mobile-terminal-font-selector">
    <!-- 1. 移动端高触感触发器卡片 (Trigger Card) -->
    <div
      role="button"
      tabindex="0"
      @click="openDrawer"
      @keydown.enter.prevent="openDrawer"
      class="group relative w-full flex items-center justify-between p-3 rounded-xl bg-background border border-border/80 hover:border-primary/60 active:scale-[0.99] transition-all cursor-pointer shadow-2xs select-none"
    >
      <!-- 左侧：字体图标与当前字体信息 -->
      <div class="flex items-center gap-3 min-w-0 pr-2">
        <div class="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
          <i class="fas fa-font text-xs"></i>
        </div>

        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span
              class="text-xs font-semibold text-foreground truncate max-w-[190px]"
              :style="{ fontFamily: props.modelValue || 'monospace' }"
            >
              {{ displayFontTitle }}
            </span>

            <span
              v-if="currentMatchedPreset"
              class="px-1.5 py-0.2 rounded-full text-[9px] font-medium bg-primary/15 text-primary border border-primary/20 shrink-0"
            >
              {{ currentMatchedPreset.categoryLabel.split(' ')[0] }}
            </span>
            <span
              v-else-if="props.modelValue && props.modelValue !== 'monospace'"
              class="px-1.5 py-0.2 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-500 border border-amber-500/20 shrink-0"
            >
              自定义
            </span>
          </div>

          <div class="text-[10px] text-text-secondary/70 truncate font-mono mt-0.5">
            {{ props.modelValue || 'monospace' }}
          </div>
        </div>
      </div>

      <!-- 右侧：操作提示与下拉箭头 -->
      <div class="flex items-center gap-1.5 shrink-0 text-text-secondary group-hover:text-primary transition-colors">
        <span class="text-[11px] font-medium hidden sm:inline">选择</span>
        <div class="w-6 h-6 rounded-md bg-header/40 flex items-center justify-center text-xs">
          <i class="fas fa-chevron-right text-[10px] transition-transform"></i>
        </div>
      </div>
    </div>

    <!-- 2. 移动端字体选择抽屉 (Bottom Sheet) -->
    <MobileBottomSheet
      :visible="isDrawerVisible"
      title="选择终端字体"
      icon="fas fa-font"
      height="h-[84vh]"
      max-height="max-h-[92dvh]"
      :z-index="props.zIndex"
      @close="closeDrawer"
    >
      <!-- 辅助顶栏：搜索框与分类标签 -->
      <template #sub-header>
        <div class="px-4 pt-1 pb-3 space-y-2.5 border-b border-border/40 bg-header/20">
          <!-- 搜索过滤条 -->
          <div class="relative w-full">
            <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-xs text-text-secondary/60 pointer-events-none"></i>
            <input
              type="text"
              v-model="searchQuery"
              placeholder="搜索字体名称、连字或特性 (如 Cascadia, Fira...)"
              class="w-full h-8.5 pl-8.5 pr-8 text-xs bg-background border border-border/70 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors font-mono"
            />
            <button
              v-if="searchQuery"
              type="button"
              @click="searchQuery = ''"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-xs p-1 cursor-pointer"
            >
              <i class="fas fa-times-circle"></i>
            </button>
          </div>

          <!-- 分类筛选横向滚动药丸 -->
          <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-0.5">
            <button
              v-for="cat in categoryFilters"
              :key="cat.key"
              type="button"
              @click="activeCategoryFilter = cat.key"
              class="h-7 px-2.5 rounded-lg text-[11px] font-medium border flex items-center gap-1 shrink-0 transition-all cursor-pointer outline-none"
              :class="activeCategoryFilter === cat.key
                ? 'bg-primary border-primary text-primary-foreground shadow-2xs font-semibold'
                : 'bg-background/80 border-border/60 text-text-secondary hover:text-foreground hover:bg-header/50'"
            >
              <i v-if="(cat as any).icon" :class="[(cat as any).icon, 'text-[10px]']"></i>
              <span v-else-if="(cat as any).emoji">{{ (cat as any).emoji }}</span>
              <span>{{ cat.label }}</span>
              <span class="text-[9px] opacity-75 ml-0.5 font-mono">({{ cat.count }})</span>
            </button>
          </div>
        </div>
      </template>

      <!-- 抽屉主体：字体列表 -->
      <div class="flex-1 overflow-y-auto p-4 space-y-3 overscroll-contain custom-scrollbar">
        <!-- A. 提示信息：当前选中字体快速定位 -->
        <div v-if="currentMatchedPreset && !searchQuery" class="flex items-center justify-between px-1 text-[11px] text-text-secondary/80">
          <span>当前已应用：<strong class="text-primary font-mono">{{ currentMatchedPreset.name }}</strong></span>
          <span class="text-[10px]">点击选项即可实时切换</span>
        </div>

        <!-- B. 自定义字体部分 (若有) -->
        <div v-if="filteredCustomFonts.length > 0" class="space-y-2">
          <div class="text-[11px] font-semibold text-text-secondary flex items-center gap-1 px-1">
            <i class="fas fa-pen-nib text-xs text-amber-500"></i>
            <span>用户自定义字体 ({{ filteredCustomFonts.length }})</span>
          </div>

          <div
            v-for="font in filteredCustomFonts"
            :key="font"
            @click="handleSelectFont(font)"
            class="group p-3 rounded-xl border transition-all cursor-pointer flex flex-col gap-1.5 active:scale-[0.99]"
            :class="isCustomFontSelected(font)
              ? 'bg-primary/10 border-primary ring-1 ring-primary/40 shadow-xs'
              : 'bg-header/25 border-border/60 hover:bg-header/50 hover:border-border'"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 min-w-0">
                <span
                  class="text-xs font-semibold text-foreground truncate"
                  :style="{ fontFamily: font }"
                >
                  {{ cleanFontName(font) }}
                </span>
                <span class="px-1.5 py-0.2 rounded-full text-[9px] bg-amber-500/15 text-amber-500 border border-amber-500/30">
                  自定义
                </span>
              </div>

              <div class="flex items-center gap-2">
                <i v-if="isCustomFontSelected(font)" class="fas fa-check-circle text-primary text-sm"></i>
                <button
                  type="button"
                  @click="(e) => handleRemoveCustomFont(font, e)"
                  class="w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:text-red-400 hover:bg-red-500/10 text-xs transition-colors"
                  title="删除此自定义字体"
                >
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>
            </div>

            <div class="text-[10px] text-text-secondary/70 font-mono truncate">
              CSS: {{ font }}
            </div>

            <!-- 字形实时渲染预览条 -->
            <div
              class="mt-1 px-2.5 py-1.5 rounded-lg bg-background/80 border border-border/40 text-[11px] text-foreground select-none leading-relaxed flex items-center justify-between"
              :style="{ fontFamily: font }"
            >
              <span>0123456789 ABC xyz</span>
              <span class="text-text-secondary/60 text-[10px]">!= &lt;= &gt;= -&gt;</span>
            </div>
          </div>
        </div>

        <!-- C. 内置精选预设列表 -->
        <div v-if="filteredPresets.length > 0" class="space-y-2.5">
          <div
            v-for="preset in filteredPresets"
            :key="preset.id"
            @click="handleSelectFont(preset.value)"
            class="group p-3 rounded-xl border transition-all cursor-pointer flex flex-col gap-1.5 active:scale-[0.99]"
            :class="isPresetSelected(preset)
              ? 'bg-primary/10 border-primary ring-1 ring-primary/40 shadow-xs'
              : 'bg-header/20 border-border/60 hover:bg-header/40 hover:border-border'"
          >
            <!-- 头部：字体名称、分类徽章与选中状态 -->
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 min-w-0">
                <span
                  class="text-xs font-semibold text-foreground truncate"
                  :style="{ fontFamily: preset.value }"
                >
                  {{ preset.name }}
                </span>
                <span class="px-1.5 py-0.2 rounded-full text-[9px] font-medium bg-header/60 text-text-secondary border border-border/60 shrink-0">
                  {{ preset.categoryLabel.split(' ')[0] }}
                </span>
                <!-- 浏览器可用性状态探测标签 -->
                <span
                  v-if="isFontAvailableInBrowser(preset.value)"
                  class="px-1.5 py-0.2 rounded-full text-[9px] font-medium bg-emerald-500/15 text-emerald-500 border border-emerald-500/25 shrink-0 hidden xs:inline"
                >
                  已安装
                </span>
              </div>

              <div class="flex items-center gap-1.5 shrink-0">
                <i
                  v-if="isPresetSelected(preset)"
                  class="fas fa-check-circle text-primary text-sm"
                ></i>
                <i
                  v-else
                  class="far fa-circle text-text-secondary/30 text-xs group-hover:text-text-secondary/60"
                ></i>
              </div>
            </div>

            <!-- 描述说明文字 (自动换行显示，杜绝原生 select 截断) -->
            <div class="text-[11px] text-text-secondary/80 leading-relaxed">
              {{ preset.description }}
            </div>

            <!-- 核心：字形与连字真实渲染预览条 -->
            <div
              class="mt-0.5 px-2.5 py-1.5 rounded-lg bg-background/80 border border-border/40 text-[11px] text-foreground select-none leading-relaxed flex items-center justify-between"
              :style="{ fontFamily: preset.value }"
            >
              <span class="font-normal">0123456789 ABCDEFGHIJKLMNOP</span>
              <span class="text-text-secondary/70 text-[10px] shrink-0 font-normal">!= &lt;= &gt;= -&gt; =&gt;</span>
            </div>
          </div>
        </div>

        <!-- D. 无搜索结果提示 -->
        <div
          v-if="filteredPresets.length === 0 && filteredCustomFonts.length === 0"
          class="py-12 text-center space-y-2"
        >
          <div class="w-10 h-10 rounded-full bg-header/60 text-text-secondary/60 flex items-center justify-center mx-auto text-base">
            <i class="fas fa-search"></i>
          </div>
          <div class="text-xs text-text-secondary">未找到匹配的终端字体</div>
          <button
            type="button"
            @click="searchQuery = ''; activeCategoryFilter = 'all'"
            class="text-xs text-primary hover:underline cursor-pointer"
          >
            重置搜索与分类条件
          </button>
        </div>

        <!-- E. 抽屉底部新增自定义字体面板 -->
        <div class="pt-2 border-t border-border/40">
          <div v-if="!isAddingCustomFont">
            <button
              type="button"
              @click="isAddingCustomFont = true"
              class="w-full h-9 rounded-xl border border-dashed border-border/80 hover:border-primary/60 bg-header/20 text-text-secondary hover:text-foreground text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer active:scale-98 transition-all"
            >
              <i class="fas fa-plus text-[10px]"></i>
              <span>添加其他字体族 (自定义输入)...</span>
            </button>
          </div>

          <div v-else class="p-3 rounded-xl bg-header/30 border border-primary/40 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-primary">输入字体名称或 CSS 族声明</span>
              <button
                type="button"
                @click="isAddingCustomFont = false"
                class="w-5 h-5 flex items-center justify-center text-text-secondary hover:text-foreground text-xs rounded cursor-pointer"
              >
                <i class="fas fa-times"></i>
              </button>
            </div>

            <div class="flex items-center gap-2">
              <input
                type="text"
                v-model="newCustomFontInput"
                @keydown.enter.prevent="handleAddCustomFont"
                placeholder="例如：'Cascadia Code', monospace"
                class="flex-1 h-8 px-2.5 text-xs rounded-lg bg-background border border-border/70 text-foreground font-mono focus:outline-none focus:border-primary"
              />
              <button
                type="button"
                @click="handleAddCustomFont"
                class="h-8 px-3 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 shrink-0 cursor-pointer shadow-2xs"
              >
                确定应用
              </button>
            </div>
            <div class="text-[10px] text-text-secondary/60">
              提示：自定义字体将同时自动保存到常用列表，方便随时切换。
            </div>
          </div>
        </div>

        <!-- 底部垫高占位，防遮挡 -->
        <div class="h-6"></div>
      </div>
    </MobileBottomSheet>
  </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
