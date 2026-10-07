<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTerminalHighlightStore } from '../../../stores/terminal-highlight.store';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import type {
  TerminalHighlightGroup,
  HighlightPriority,
  HighlightMatcherItem,
  BuiltinMatcherType,
} from '../../../types/terminal-highlight.types';

const props = defineProps<{
  isVisible: boolean;
  groupToEdit?: TerminalHighlightGroup | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const highlightStore = useTerminalHighlightStore();
const notificationsStore = useUiNotificationsStore();

const isEditing = computed(() => !!props.groupToEdit);

// 调色盘快速候选色
const PALETTE_COLORS = [
  '#22c55e', '#ef4444', '#f59e0b', '#06b6d4',
  '#3b82f6', '#c084fc', '#f43f5e', '#2dd4bf',
  '#facc15', '#94a3b8',
];

// 内置类型候选项
const BUILTIN_TYPE_OPTIONS: { value: BuiltinMatcherType; label: string }[] = [
  { value: 'date', label: '🕒 时间戳' },
  { value: 'error', label: '🔴 错误与异常' },
  { value: 'warning', label: '🟡 警告与告警' },
  { value: 'success', label: '🟢 成功与运行状态' },
  { value: 'info', label: '🔵 日志级别' },
  { value: 'ip', label: '🟣 IP 地址与端口' },
  { value: 'url', label: '🌐 Web 链接' },
];

interface FormMatcherItem {
  id: string;
  type: 'builtin' | 'keyword' | 'regex';
  builtinType?: BuiltinMatcherType;
  keyword?: string;
  wholeWord?: boolean;
  caseSensitive?: boolean;
  pattern?: string;
  flags?: string;
  error?: string | null;
}

const formData = ref<{
  name: string;
  description: string;
  color: string;
  bold: boolean;
  underline: boolean;
  priority: HighlightPriority;
  matchers: FormMatcherItem[];
}>({
  name: '',
  description: '',
  color: '#3b82f6',
  bold: false,
  underline: false,
  priority: 2,
  matchers: [],
});

const generateId = () => `m_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

// 校验正则表达式有效性
const validateRegexItem = (item: FormMatcherItem) => {
  if (item.type !== 'regex' || !item.pattern?.trim()) {
    item.error = null;
    return;
  }
  try {
    const f = item.flags && item.flags.includes('g') ? item.flags : `${item.flags || ''}g`;
    new RegExp(item.pattern.trim(), f);
    item.error = null;
  } catch (err: any) {
    item.error = err.message || '无效的正则表达式语法';
  }
};

// 重置并初始化表单
const initForm = () => {
  if (props.groupToEdit) {
    const group = props.groupToEdit;
    const formMatchers: FormMatcherItem[] = [];

    if (Array.isArray(group.matchers) && group.matchers.length > 0) {
      for (const m of group.matchers) {
        formMatchers.push({
          id: m.id || generateId(),
          type: m.type,
          builtinType: m.builtinType,
          keyword: m.keyword,
          wholeWord: m.wholeWord !== false,
          caseSensitive: !!m.caseSensitive,
          pattern: m.pattern,
          flags: m.flags || 'g',
          error: null,
        });
      }
    } else {
      // 兼容回填
      if (group.builtinType) {
        formMatchers.push({
          id: generateId(),
          type: 'builtin',
          builtinType: group.builtinType,
        });
      }
      if (group.keywords && group.keywords.length > 0) {
        for (const kw of group.keywords) {
          formMatchers.push({
            id: generateId(),
            type: 'keyword',
            keyword: kw,
            wholeWord: group.keywordWholeWord !== false,
            caseSensitive: !!group.keywordCaseSensitive,
          });
        }
      }
      if (group.patterns && group.patterns.length > 0) {
        for (const pat of group.patterns) {
          formMatchers.push({
            id: generateId(),
            type: 'regex',
            pattern: pat,
            flags: group.flags || 'g',
            error: null,
          });
        }
      }
    }

    if (formMatchers.length === 0) {
      formMatchers.push({
        id: generateId(),
        type: 'keyword',
        keyword: '',
        wholeWord: true,
        caseSensitive: false,
      });
    }

    formData.value = {
      name: group.name,
      description: group.description || '',
      color: group.color || '#3b82f6',
      bold: !!group.bold,
      underline: !!group.underline,
      priority: group.priority || 2,
      matchers: formMatchers,
    };
  } else {
    formData.value = {
      name: '',
      description: '',
      color: '#3b82f6',
      bold: false,
      underline: false,
      priority: 2,
      matchers: [
        {
          id: generateId(),
          type: 'keyword',
          keyword: '',
          wholeWord: true,
          caseSensitive: false,
        },
      ],
    };
  }
};

watch(() => props.isVisible, (val) => {
  if (val) {
    initForm();
  }
}, { immediate: true });

// 添加 Matcher
const handleAddKeywordMatcher = () => {
  formData.value.matchers.push({
    id: generateId(),
    type: 'keyword',
    keyword: '',
    wholeWord: true,
    caseSensitive: false,
  });
};

const handleAddRegexMatcher = () => {
  formData.value.matchers.push({
    id: generateId(),
    type: 'regex',
    pattern: '',
    flags: 'g',
    error: null,
  });
};

const handleAddBuiltinMatcher = () => {
  formData.value.matchers.push({
    id: generateId(),
    type: 'builtin',
    builtinType: 'error',
  });
};

const handleRemoveMatcher = (index: number) => {
  formData.value.matchers.splice(index, 1);
};

// 提交保存
const handleSave = () => {
  if (!formData.value.name.trim()) {
    notificationsStore.addNotification({ type: 'warning', message: '请输入分组名称' });
    return;
  }

  let hasError = false;
  const cleanedMatchers: HighlightMatcherItem[] = [];

  for (const m of formData.value.matchers) {
    if (m.type === 'regex') {
      validateRegexItem(m);
      if (m.error) hasError = true;
      if (m.pattern?.trim()) {
        cleanedMatchers.push({
          id: m.id,
          type: 'regex',
          pattern: m.pattern.trim(),
          flags: m.flags || 'g',
        });
      }
    } else if (m.type === 'keyword') {
      if (m.keyword?.trim()) {
        cleanedMatchers.push({
          id: m.id,
          type: 'keyword',
          keyword: m.keyword.trim(),
          wholeWord: m.wholeWord !== false,
          caseSensitive: !!m.caseSensitive,
        });
      }
    } else if (m.type === 'builtin') {
      cleanedMatchers.push({
        id: m.id,
        type: 'builtin',
        builtinType: m.builtinType || 'error',
      });
    }
  }

  if (hasError) {
    notificationsStore.addNotification({ type: 'error', message: '请修正正则表达式中的语法错误' });
    return;
  }

  const keywords = cleanedMatchers
    .filter((m) => m.type === 'keyword' && m.keyword)
    .map((m) => m.keyword!);
  const patterns = cleanedMatchers
    .filter((m) => m.type === 'regex' && m.pattern)
    .map((m) => m.pattern!);
  const builtinItem = cleanedMatchers.find((m) => m.type === 'builtin');

  if (props.groupToEdit) {
    highlightStore.updateGroup(props.groupToEdit.id, {
      name: formData.value.name.trim(),
      description: formData.value.description.trim(),
      color: formData.value.color,
      bold: formData.value.bold,
      underline: formData.value.underline,
      priority: formData.value.priority,
      matchers: cleanedMatchers,
      keywords,
      patterns,
      builtinType: builtinItem?.builtinType,
    });
    notificationsStore.addNotification({ type: 'success', message: '高亮规则已更新' });
  } else {
    highlightStore.addGroup({
      name: formData.value.name.trim(),
      description: formData.value.description.trim(),
      enabled: true,
      color: formData.value.color,
      bold: formData.value.bold,
      underline: formData.value.underline,
      priority: formData.value.priority,
      matchers: cleanedMatchers,
      keywords,
      patterns,
      builtinType: builtinItem?.builtinType,
    });
    notificationsStore.addNotification({ type: 'success', message: '已添加新高亮规则' });
  }

  emit('close');
};
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        v-if="isVisible"
        class="fixed inset-0 z-[1050] flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="emit('close')"
      >
        <!-- 抽屉容器 -->
        <div class="w-full h-[90vh] max-h-[92vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden select-text text-foreground">
          <!-- 1. 顶部手柄条与标题栏 -->
          <div class="sheet-top shrink-0 select-none border-b border-border/40 bg-header/40">
            <!-- 拖拽指示条 -->
            <div
              class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
              @click="emit('close')"
              title="点击收起"
            >
              <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
            </div>

            <!-- 顶栏标题与操作 -->
            <div class="flex items-center justify-between px-4 py-2">
              <!-- 左侧返回按钮 (统一快捷指令面板幽灵按钮规范) -->
              <button
                type="button"
                @click="emit('close')"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
                title="返回"
              >
                <i class="fas fa-chevron-left text-sm"></i>
              </button>

              <h3 class="text-sm font-semibold text-foreground tracking-tight">
                {{ isEditing ? '编辑高亮规则' : '添加高亮规则' }}
              </h3>

              <!-- 右侧保存按钮 -->
              <button
                type="button"
                @click="handleSave"
                class="px-3.5 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all shadow-xs cursor-pointer"
              >
                保存
              </button>
            </div>
          </div>

          <!-- 2. 主体可滚动表单区 -->
          <div class="flex-grow overflow-y-auto px-4 py-3.5 space-y-3.5 overscroll-contain">
            <!-- 卡片 A：基本信息 -->
            <div class="bg-header/30 border border-border/50 rounded-2xl p-3.5 space-y-3 shadow-2xs">
              <div class="text-xs font-semibold text-text-secondary">基本信息</div>
              <div class="space-y-2">
                <div>
                  <label class="block text-[11px] text-text-secondary mb-1">分组名称 *</label>
                  <input
                    type="text"
                    v-model="formData.name"
                    placeholder="例如：核心业务日志 / Docker 容器"
                    class="w-full px-3 py-1.5 text-xs rounded-xl border border-border/70 bg-background text-foreground focus:outline-none focus:border-primary font-medium"
                  />
                </div>
                <div>
                  <label class="block text-[11px] text-text-secondary mb-1">描述说明 (可选)</label>
                  <input
                    type="text"
                    v-model="formData.description"
                    placeholder="说明匹配用途"
                    class="w-full px-3 py-1.5 text-xs rounded-xl border border-border/70 bg-background text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              </div>
            </div>

            <!-- 卡片 B：样式与冲突仲裁 -->
            <div class="bg-header/30 border border-border/50 rounded-2xl p-3.5 space-y-3 shadow-2xs">
              <div class="text-xs font-semibold text-text-secondary">共享样式与优先级</div>

              <!-- 颜色配置行 -->
              <div class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] text-text-secondary">着色颜色</span>
                  <div class="flex items-center gap-1.5">
                    <input
                      type="text"
                      v-model="formData.color"
                      class="w-20 px-1.5 py-0.5 text-[11px] font-mono uppercase text-center rounded-lg border border-border/70 bg-background text-foreground"
                    />
                    <div class="relative w-6 h-6 rounded-full overflow-hidden border border-border shrink-0 cursor-pointer">
                      <input
                        type="color"
                        v-model="formData.color"
                        class="absolute -inset-2 w-10 h-10 opacity-0 cursor-pointer"
                      />
                      <div class="w-full h-full" :style="{ backgroundColor: formData.color }"></div>
                    </div>
                  </div>
                </div>

                <!-- 调色板快选点 -->
                <div class="flex items-center gap-2 flex-wrap pt-1">
                  <button
                    v-for="c in PALETTE_COLORS"
                    :key="c"
                    type="button"
                    @click="formData.color = c"
                    class="w-5 h-5 rounded-full border border-black/10 transition-transform cursor-pointer"
                    :class="{ 'scale-125 ring-2 ring-primary ring-offset-1 ring-offset-background': formData.color === c }"
                    :style="{ backgroundColor: c }"
                  ></button>
                </div>
              </div>

              <!-- 文字修饰与优先级 -->
              <div class="pt-2 border-t border-border/30 flex items-center justify-between gap-2 flex-wrap">
                <!-- 加粗与下划线 -->
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    @click="formData.bold = !formData.bold"
                    class="px-2.5 py-1 text-xs rounded-lg border transition-colors cursor-pointer"
                    :class="formData.bold ? 'bg-primary border-primary text-primary-foreground font-bold shadow-2xs' : 'bg-background border-border/60 text-text-secondary'"
                  >
                    加粗
                  </button>
                  <button
                    type="button"
                    @click="formData.underline = !formData.underline"
                    class="px-2.5 py-1 text-xs rounded-lg border underline transition-colors cursor-pointer"
                    :class="formData.underline ? 'bg-primary border-primary text-primary-foreground font-semibold shadow-2xs' : 'bg-background border-border/60 text-text-secondary'"
                  >
                    下划线
                  </button>
                </div>

                <!-- 优先级分段器 -->
                <div class="flex items-center gap-1 bg-background border border-border/60 rounded-xl p-0.5">
                  <span class="text-[10px] text-text-secondary/70 px-1.5">优先级:</span>
                  <button
                    type="button"
                    @click="formData.priority = 3"
                    class="px-2 py-0.5 rounded-lg text-[10px] font-medium transition-colors cursor-pointer"
                    :class="formData.priority === 3 ? 'bg-primary text-primary-foreground' : 'text-text-secondary hover:text-foreground'"
                  >高</button>
                  <button
                    type="button"
                    @click="formData.priority = 2"
                    class="px-2 py-0.5 rounded-lg text-[10px] font-medium transition-colors cursor-pointer"
                    :class="formData.priority === 2 ? 'bg-primary text-primary-foreground' : 'text-text-secondary hover:text-foreground'"
                  >普通</button>
                  <button
                    type="button"
                    @click="formData.priority = 1"
                    class="px-2 py-0.5 rounded-lg text-[10px] font-medium transition-colors cursor-pointer"
                    :class="formData.priority === 1 ? 'bg-primary text-primary-foreground' : 'text-text-secondary hover:text-foreground'"
                  >低</button>
                </div>
              </div>
            </div>

            <!-- 卡片 C：匹配规则条目列表 (Matchers) -->
            <div class="space-y-2.5">
              <div class="flex items-center justify-between px-0.5">
                <div>
                  <div class="text-xs font-semibold text-text-secondary">匹配规则列表 (Matchers)</div>
                  <div class="text-[10px] text-text-secondary/60">可组合添加多项，共享上方着色样式</div>
                </div>

                <!-- 添加入口按钮组 -->
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    @click="handleAddKeywordMatcher"
                    class="px-2 py-1 text-[11px] rounded-lg bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 font-medium transition-colors cursor-pointer"
                  >
                    + 关键词
                  </button>
                  <button
                    type="button"
                    @click="handleAddRegexMatcher"
                    class="px-2 py-1 text-[11px] rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border border-purple-500/30 font-medium transition-colors cursor-pointer"
                  >
                    + 正则
                  </button>
                  <button
                    type="button"
                    @click="handleAddBuiltinMatcher"
                    class="px-2 py-1 text-[11px] rounded-lg bg-background hover:bg-header border border-border/70 text-text-secondary hover:text-foreground font-medium transition-colors cursor-pointer"
                  >
                    + 内置
                  </button>
                </div>
              </div>

              <!-- Matcher 条目列表 -->
              <div class="space-y-2">
                <div
                  v-for="(item, idx) in formData.matchers"
                  :key="item.id"
                  class="bg-header/25 border border-border/50 rounded-2xl p-3 space-y-2 shadow-2xs"
                >
                  <div class="flex items-center justify-between">
                    <!-- 类型 Badge -->
                    <span
                      class="px-1.5 py-0.5 rounded-md text-[10px] font-mono uppercase font-semibold border"
                      :class="[
                        item.type === 'builtin' ? 'bg-primary/10 text-primary border-primary/30' :
                        item.type === 'regex' ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' :
                        'bg-blue-500/10 text-blue-400 border-blue-500/30'
                      ]"
                    >
                      {{ item.type === 'builtin' ? '内置' : (item.type === 'regex' ? '正则' : '关键词') }}
                    </span>

                    <!-- 移除按钮 -->
                    <button
                      type="button"
                      @click="handleRemoveMatcher(idx)"
                      class="w-6 h-6 flex items-center justify-center rounded-lg text-text-secondary hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all cursor-pointer"
                      title="删除此规则"
                    >
                      <i class="fas fa-trash-alt text-xs"></i>
                    </button>
                  </div>

                  <!-- 关键词类型输入 -->
                  <div v-if="item.type === 'keyword'" class="space-y-2">
                    <input
                      type="text"
                      v-model="item.keyword"
                      placeholder="输入关键词，例如：FATAL, Timeout"
                      class="w-full px-2.5 py-1.5 text-xs rounded-xl bg-background border border-border/70 text-foreground font-mono focus:outline-none focus:border-primary"
                    />
                    <div class="flex items-center gap-2">
                      <button
                        type="button"
                        @click="item.wholeWord = !item.wholeWord"
                        class="px-2 py-0.5 rounded-lg text-[10px] border transition-colors cursor-pointer"
                        :class="item.wholeWord ? 'bg-primary/15 border-primary text-primary font-semibold' : 'bg-background border-border/60 text-text-secondary'"
                      >
                        全词匹配
                      </button>
                      <button
                        type="button"
                        @click="item.caseSensitive = !item.caseSensitive"
                        class="px-2 py-0.5 rounded-lg text-[10px] border transition-colors cursor-pointer"
                        :class="item.caseSensitive ? 'bg-primary/15 border-primary text-primary font-semibold' : 'bg-background border-border/60 text-text-secondary'"
                      >
                        区分大小写
                      </button>
                    </div>
                  </div>

                  <!-- 正则表达式类型输入 -->
                  <div v-else-if="item.type === 'regex'" class="space-y-1.5">
                    <div class="flex items-center gap-1.5">
                      <span class="text-xs font-mono text-text-secondary/60">/</span>
                      <input
                        type="text"
                        v-model="item.pattern"
                        @input="validateRegexItem(item)"
                        placeholder="如 \\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b"
                        class="flex-grow min-w-0 px-2.5 py-1.5 text-xs rounded-xl bg-background border border-border/70 text-foreground font-mono focus:outline-none focus:border-purple-400"
                      />
                      <span class="text-xs font-mono text-text-secondary/60">/</span>
                      <input
                        type="text"
                        v-model="item.flags"
                        @input="validateRegexItem(item)"
                        placeholder="g"
                        class="w-12 px-2 py-1.5 text-xs text-center rounded-xl bg-background border border-border/70 text-foreground font-mono focus:outline-none focus:border-purple-400"
                      />
                    </div>
                    <div v-if="item.error" class="text-[10px] text-red-500 font-mono pl-1">
                      {{ item.error }}
                    </div>
                  </div>

                  <!-- 内置类型下拉 -->
                  <div v-else-if="item.type === 'builtin'">
                    <select
                      v-model="item.builtinType"
                      class="w-full px-2.5 py-1.5 text-xs rounded-xl bg-background border border-border/70 text-foreground focus:outline-none focus:border-primary"
                    >
                      <option
                        v-for="opt in BUILTIN_TYPE_OPTIONS"
                        :key="opt.value"
                        :value="opt.value"
                      >
                        {{ opt.label }}
                      </option>
                    </select>
                  </div>
                </div>

                <!-- 规则为空时的指引 -->
                <div v-if="formData.matchers.length === 0" class="py-6 text-center text-xs text-text-secondary space-y-2 border border-dashed border-border/60 rounded-2xl">
                  <i class="fas fa-filter text-base text-text-secondary/40"></i>
                  <div>尚未添加任何匹配条件</div>
                  <div class="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      @click="handleAddKeywordMatcher"
                      class="px-2.5 py-1 rounded-lg bg-primary/10 text-primary font-semibold text-xs cursor-pointer"
                    >
                      添加关键词
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.25s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

.bottom-sheet-enter-active > div,
.bottom-sheet-leave-active > div {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-enter-from > div,
.bottom-sheet-leave-to > div {
  transform: translateY(100%);
}
</style>
