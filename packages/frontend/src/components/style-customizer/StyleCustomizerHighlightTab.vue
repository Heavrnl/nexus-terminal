<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '../common/ToggleSwitch.vue';
import { useTerminalHighlightStore } from '../../stores/terminal-highlight.store';
import type {
  TerminalHighlightGroup,
  HighlightPriority,
  HighlightMatcherItem,
  BuiltinMatcherType,
} from '../../types/terminal-highlight.types';
import { ansiToHtml } from '../../utils/terminal-highlighter';

const { t } = useI18n();
const highlightStore = useTerminalHighlightStore();

// 调色盘快速候选色
const PALETTE_COLORS = [
  '#22c55e', // 绿色
  '#ef4444', // 红色
  '#f59e0b', // 琥珀黄
  '#06b6d4', // 青色
  '#3b82f6', // 蓝色
  '#c084fc', // 紫色
  '#f43f5e', // 玫红
  '#2dd4bf', // 薄荷绿
  '#facc15', // 金黄
  '#94a3b8', // 灰蓝
];

// 内置类型候选项
const BUILTIN_TYPE_OPTIONS: { value: BuiltinMatcherType; label: string }[] = [
  { value: 'date', label: '🕒 时间戳 (ISO / 逗号点号毫秒 / Syslog)' },
  { value: 'error', label: '🔴 错误状态与非零退出码 (ERROR / FATAL / exit code)' },
  { value: 'warning', label: '🟡 警告与超时状态 (WARN / timeout / retry)' },
  { value: 'success', label: '🟢 成功与健康运行 (Up / healthy / active / OK)' },
  { value: 'info', label: '🔵 日志级别 (INFO / DEBUG / TRACE)' },
  { value: 'ip', label: '🟣 网络 IP 地址与端口 (IPv4 / Port)' },
  { value: 'url', label: '🌐 Web 链接 (HTTP / HTTPS / URLs)' },
];

// 实时预览样本定义
type PreviewSampleKey = 'docker' | 'log' | 'network';
const currentSample = ref<PreviewSampleKey>('docker');

const SAMPLES: Record<PreviewSampleKey, string> = {
  docker: `$ docker ps -a
CONTAINER ID   IMAGE          COMMAND                  STATUS                    PORTS                  NAMES
9b8a7c6d5e4f   nginx:alpine   "/docker-entrypoint.…"   Up 2 hours                0.0.0.0:80->80/tcp     web-frontend
1a2b3c4d5e6f   mysql:8.0      "docker-entrypoint.s…"   Exited (1) 10 mins ago    0.0.0.0:3306->3306/tcp db-production
3c4d5e6f7a8b   redis:7-alpine "docker-entrypoint.s…"   Up 1 day (healthy)        0.0.0.0:6379->6379/tcp cache-redis`,

  log: `$ tail -n 3 /var/log/nginx/access.log
2026-10-06 18:30:15,084 [INFO] 192.168.1.100 GET https://nexus.example.com/api/v1/health 200 OK
2026-10-06 18:30:16.120 [WARN] Slow database query from 10.0.0.8:5432, duration: 1820ms
2026-10-06 18:30:17,452 [ERROR] Connection refused to 172.16.0.4:6379, retry 3 of 5 failed! exit code 1`,

  network: `$ ip addr show eth0 && netstat -tlpn
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP group default
    inet 192.168.1.188/24 brd 192.168.1.255 scope global eth0
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      892/sshd
tcp        0      0 127.0.0.1:3000          0.0.0.0:*               LISTEN      14205/node`,
};

// 实时计算预览 HTML
const previewHtml = computed(() => {
  const text = SAMPLES[currentSample.value];
  const highlightedAnsi = highlightStore.highlight(text);
  return ansiToHtml(typeof highlightedAnsi === 'string' ? highlightedAnsi : text);
});

// 编辑与新增弹窗表单状态
const isEditModalOpen = ref(false);
const editingGroupId = ref<string | null>(null);

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

const groupForm = ref<{
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

// 生成简易唯一 ID
const generateId = () => `m_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

// 校验单条正则
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

// 添加各类 Matcher
const handleAddBuiltinMatcher = () => {
  groupForm.value.matchers.push({
    id: generateId(),
    type: 'builtin',
    builtinType: 'error',
  });
};

const handleAddKeywordMatcher = () => {
  groupForm.value.matchers.push({
    id: generateId(),
    type: 'keyword',
    keyword: '',
    wholeWord: true,
    caseSensitive: false,
  });
};

const handleAddRegexMatcher = () => {
  groupForm.value.matchers.push({
    id: generateId(),
    type: 'regex',
    pattern: '',
    flags: 'g',
    error: null,
  });
};

// 移除单个 Matcher
const handleRemoveMatcher = (index: number) => {
  groupForm.value.matchers.splice(index, 1);
};

// 打开新建分组弹窗
const handleOpenAddModal = () => {
  editingGroupId.value = null;
  groupForm.value = {
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
  isEditModalOpen.value = true;
};

// 打开编辑弹窗
const handleOpenEditModal = (group: TerminalHighlightGroup) => {
  editingGroupId.value = group.id;

  // 将 Group 内的 matchers 转换为表单项，如缺少 matchers 则由 keywords/patterns 回填
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

  // 若仍为空则默认置入一项关键词输入
  if (formMatchers.length === 0) {
    formMatchers.push({
      id: generateId(),
      type: 'keyword',
      keyword: '',
      wholeWord: true,
      caseSensitive: false,
    });
  }

  groupForm.value = {
    name: group.name,
    description: group.description || '',
    color: group.color,
    bold: !!group.bold,
    underline: !!group.underline,
    priority: group.priority || 2,
    matchers: formMatchers,
  };
  isEditModalOpen.value = true;
};

// 保存分组
const handleSaveGroup = () => {
  if (!groupForm.value.name.trim()) return;

  // 校验所有正则并清理空项
  let hasError = false;
  const cleanedMatchers: HighlightMatcherItem[] = [];

  for (const m of groupForm.value.matchers) {
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

  if (hasError) return;

  // 提取关键词和正则列表作为辅助字段
  const keywords = cleanedMatchers
    .filter((m) => m.type === 'keyword' && m.keyword)
    .map((m) => m.keyword!);
  const patterns = cleanedMatchers
    .filter((m) => m.type === 'regex' && m.pattern)
    .map((m) => m.pattern!);
  const builtinItem = cleanedMatchers.find((m) => m.type === 'builtin');

  if (editingGroupId.value) {
    highlightStore.updateGroup(editingGroupId.value, {
      name: groupForm.value.name.trim(),
      description: groupForm.value.description.trim(),
      color: groupForm.value.color,
      bold: groupForm.value.bold,
      underline: groupForm.value.underline,
      priority: groupForm.value.priority,
      matchers: cleanedMatchers,
      keywords,
      patterns,
      builtinType: builtinItem?.builtinType,
    });
  } else {
    highlightStore.addGroup({
      name: groupForm.value.name.trim(),
      description: groupForm.value.description.trim(),
      enabled: true,
      color: groupForm.value.color,
      bold: groupForm.value.bold,
      underline: groupForm.value.underline,
      priority: groupForm.value.priority,
      matchers: cleanedMatchers,
      keywords,
      patterns,
      builtinType: builtinItem?.builtinType,
    });
  }

  isEditModalOpen.value = false;
};

// 恢复预设
const handleResetToDefault = () => {
  if (confirm(t('styleCustomizer.confirmResetHighlight', '确定恢复为系统预设高亮分组？自定义分组将被清空。'))) {
    highlightStore.resetToDefault();
  }
};
</script>

<template>
  <div class="space-y-4 pb-4">
    <!-- 1. 顶部控制栏 -->
    <div class="bg-header/40 border border-border rounded-lg p-3.5 flex items-center justify-between gap-4 shadow-2xs">
      <div class="flex items-center gap-3">
        <span class="text-base font-semibold text-foreground">
          {{ t('styleCustomizer.highlightTitle', '终端代码高亮') }}
        </span>
        <ToggleSwitch
          :model-value="highlightStore.enabled"
          @update:model-value="highlightStore.toggleEnabled"
          aria-label="启用终端高亮"
        />
      </div>

      <div class="flex items-center gap-2.5">
        <button
          @click="handleResetToDefault"
          class="px-3 py-1.5 text-sm border border-border rounded-md bg-background hover:bg-muted text-text-secondary hover:text-foreground transition-colors flex items-center gap-1.5"
          :title="t('styleCustomizer.resetHighlightTitle', '恢复内置语义分组')"
        >
          <i class="fas fa-rotate-left text-xs"></i>
          {{ t('styleCustomizer.resetDefault', '恢复预设') }}
        </button>
        <button
          @click="handleOpenAddModal"
          class="px-3.5 py-1.5 text-sm border border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary rounded-md transition-colors font-medium flex items-center gap-1.5"
        >
          <i class="fas fa-plus text-xs"></i>
          {{ t('styleCustomizer.addGroup', '新建高亮分组') }}
        </button>
      </div>
    </div>

    <!-- 2. 实时预览视口 -->
    <div class="border border-border rounded-lg overflow-hidden shadow-2xs bg-[#12141a]">
      <div class="px-3.5 py-2 border-b border-border/40 bg-[#1a1d24] flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          <span class="w-2.5 h-2.5 rounded-full bg-red-500/80 inline-block"></span>
          <span class="w-2.5 h-2.5 rounded-full bg-yellow-500/80 inline-block"></span>
          <span class="w-2.5 h-2.5 rounded-full bg-green-500/80 inline-block"></span>
          <span class="text-xs font-mono text-gray-400 ml-2">{{ t('styleCustomizer.livePreview', '效果预览') }}</span>
        </div>

        <div class="flex items-center gap-1.5">
          <button
            @click="currentSample = 'docker'"
            :class="['px-2.5 py-1 text-xs rounded transition-colors font-medium', currentSample === 'docker' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white']"
          >
            Docker
          </button>
          <button
            @click="currentSample = 'log'"
            :class="['px-2.5 py-1 text-xs rounded transition-colors font-medium', currentSample === 'log' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white']"
          >
            Logs
          </button>
          <button
            @click="currentSample = 'network'"
            :class="['px-2.5 py-1 text-xs rounded transition-colors font-medium', currentSample === 'network' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white']"
          >
            Network
          </button>
        </div>
      </div>

      <div class="p-3.5 font-mono text-xs md:text-sm leading-relaxed text-gray-200 overflow-x-auto whitespace-pre h-44 overflow-y-auto">
        <div v-html="previewHtml"></div>
      </div>
    </div>

    <!-- 3. 高亮语义分组卡片列表 -->
    <div class="border border-border rounded-lg overflow-hidden bg-background shadow-2xs">
      <div class="px-3.5 py-2.5 border-b border-border bg-header/30 flex items-center justify-between">
        <span class="text-sm font-semibold text-foreground">
          {{ t('styleCustomizer.groupsList', '高亮语义分组') }}
          <span class="font-normal text-text-secondary text-xs">({{ highlightStore.groups.length }})</span>
        </span>
        <span class="text-xs text-text-secondary">
          多 Matcher 自由组合 · 共享分组样式与优先级
        </span>
      </div>

      <div class="divide-y divide-border/30">
        <div
          v-for="(group, index) in highlightStore.groups"
          :key="group.id"
          class="p-3.5 hover:bg-muted/15 transition-colors space-y-2.5"
        >
          <!-- 卡片头部：开关 + 标题 + 徽章 + 样式属性与操作按钮 -->
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <ToggleSwitch
                :model-value="group.enabled"
                @update:model-value="(val) => highlightStore.toggleGroup(group.id, val)"
                :aria-label="`启用 ${group.name}`"
              />

              <span
                class="font-medium text-sm text-foreground select-none"
                :class="{ 'opacity-50 line-through': !group.enabled }"
              >
                {{ group.name }}
              </span>

              <!-- 内置 / 自定义徽标 -->
              <span
                v-if="group.isBuiltin"
                class="px-1.5 py-0.5 text-[10px] rounded bg-muted text-text-secondary font-mono border border-border/40 shrink-0"
              >
                内置
              </span>
              <span
                v-else
                class="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary font-mono border border-primary/20 shrink-0"
              >
                自定义
              </span>

              <!-- 规则统计标记 -->
              <span class="text-[11px] text-text-secondary hidden sm:inline-block">
                ({{ (group.matchers?.length || (group.keywords?.length || 0) + (group.patterns?.length || 0)) }} 条规则)
              </span>
            </div>

            <!-- 右侧：样式属性与操作按钮 -->
            <div class="flex items-center gap-1.5 shrink-0">
              <!-- 拾色器 -->
              <label
                class="relative cursor-pointer w-7 h-7 rounded-md border border-border overflow-hidden shadow-2xs flex items-center justify-center shrink-0 hover:ring-1 hover:ring-primary transition-all"
                :title="t('styleCustomizer.pickColor', '选择颜色')"
              >
                <input
                  type="color"
                  v-model="group.color"
                  class="absolute -top-4 -left-4 w-16 h-16 cursor-pointer opacity-0"
                />
                <span class="w-full h-full" :style="{ backgroundColor: group.color }"></span>
              </label>

              <!-- 加粗开关 B -->
              <button
                @click="group.bold = !group.bold"
                :class="[
                  'w-7 h-7 rounded-md text-xs font-bold border transition-colors flex items-center justify-center',
                  group.bold ? 'bg-primary text-white border-primary shadow-xs' : 'bg-background text-text-secondary border-border hover:bg-muted'
                ]"
                title="加粗 (Bold)"
              >
                B
              </button>

              <!-- 下划线开关 U -->
              <button
                @click="group.underline = !group.underline"
                :class="[
                  'w-7 h-7 rounded-md text-xs underline border transition-colors flex items-center justify-center font-serif',
                  group.underline ? 'bg-primary text-white border-primary shadow-xs' : 'bg-background text-text-secondary border-border hover:bg-muted'
                ]"
                title="下划线 (Underline)"
              >
                U
              </button>

              <div class="h-4 w-px bg-border/60 mx-0.5"></div>

              <!-- 排序：上移 -->
              <button
                @click="highlightStore.moveGroup(index, index - 1)"
                :disabled="index === 0"
                class="w-7 h-7 text-text-secondary hover:text-foreground hover:bg-muted disabled:opacity-25 disabled:cursor-not-allowed rounded-md border border-border flex items-center justify-center transition-colors"
                title="上移"
              >
                <i class="fas fa-chevron-up text-xs"></i>
              </button>
              <!-- 排序：下移 -->
              <button
                @click="highlightStore.moveGroup(index, index + 1)"
                :disabled="index === highlightStore.groups.length - 1"
                class="w-7 h-7 text-text-secondary hover:text-foreground hover:bg-muted disabled:opacity-25 disabled:cursor-not-allowed rounded-md border border-border flex items-center justify-center transition-colors"
                title="下移"
              >
                <i class="fas fa-chevron-down text-xs"></i>
              </button>

              <div class="h-4 w-px bg-border/60 mx-0.5"></div>

              <!-- 编辑 -->
              <button
                @click="handleOpenEditModal(group)"
                class="w-7 h-7 rounded-md border border-border bg-background hover:bg-muted text-text-secondary hover:text-foreground transition-colors flex items-center justify-center"
                title="编辑分组规则"
              >
                <i class="fas fa-pen text-xs"></i>
              </button>

              <!-- 删除 (仅自建分组允许删除，内置受保护) -->
              <button
                v-if="!group.isBuiltin"
                @click="highlightStore.deleteGroup(group.id)"
                class="w-7 h-7 rounded-md border border-border bg-background hover:bg-red-500/10 text-text-secondary hover:text-red-500 transition-colors flex items-center justify-center"
                title="删除分组"
              >
                <i class="fas fa-trash-can text-xs"></i>
              </button>
            </div>
          </div>

          <!-- 卡片内容：展示该 Group 包含的各 Matcher 胶囊 -->
          <div class="pl-9 text-xs">
            <div class="flex flex-wrap items-center gap-1.5">
              <!-- 若有 matchers 列表 -->
              <template v-if="group.matchers && group.matchers.length > 0">
                <span
                  v-for="m in group.matchers"
                  :key="m.id"
                  class="px-2 py-0.5 rounded text-[11px] font-mono border flex items-center gap-1"
                  :class="[
                    m.type === 'builtin' ? 'bg-primary/10 text-primary border-primary/20' :
                    m.type === 'regex' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' :
                    'bg-muted/60 text-foreground border-border/40'
                  ]"
                >
                  <i v-if="m.type === 'builtin'" class="fas fa-shield-halved text-[9px]"></i>
                  <i v-else-if="m.type === 'regex'" class="fas fa-code text-[9px]"></i>
                  <i v-else class="fas fa-tag text-[9px]"></i>
                  <span>{{ m.type === 'builtin' ? m.builtinType : (m.type === 'regex' ? `/${m.pattern}/` : m.keyword) }}</span>
                </span>
              </template>

              <!-- 兼容关键词展示 -->
              <template v-else-if="group.keywords && group.keywords.length > 0">
                <span
                  v-for="(kw, kwIdx) in group.keywords"
                  :key="kwIdx"
                  class="px-2 py-0.5 rounded bg-muted/60 text-foreground font-mono text-[11px] border border-border/40"
                >
                  {{ kw }}
                </span>
              </template>
            </div>

            <!-- 描述信息 -->
            <p v-if="group.description" class="text-text-secondary text-[11px] mt-1.5">
              {{ group.description }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. 添加/编辑高亮分组与 Matcher 列表 Modal 弹窗 -->
    <div
      v-if="isEditModalOpen"
      class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      @click.self="isEditModalOpen = false"
    >
      <div class="bg-background text-foreground rounded-xl shadow-2xl w-full max-w-xl border border-border overflow-hidden flex flex-col max-h-[85vh]">
        <!-- 弹窗顶栏 -->
        <header class="px-5 py-3.5 border-b border-border bg-header/60 flex justify-between items-center shrink-0">
          <h3 class="font-semibold text-base">
            {{ editingGroupId ? t('styleCustomizer.editGroup', '编辑高亮分组') : t('styleCustomizer.createGroup', '新建高亮分组') }}
          </h3>
          <button @click="isEditModalOpen = false" class="text-text-secondary hover:text-foreground text-xl leading-none">&times;</button>
        </header>

        <!-- 弹窗表单主体 (支持滚动) -->
        <div class="p-5 space-y-4 bg-background overflow-y-auto flex-1">
          <!-- 1. 基本信息：分组名称与描述 -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium text-text-secondary mb-1">
                {{ t('styleCustomizer.groupName', '分组名称') }} *
              </label>
              <input
                type="text"
                v-model="groupForm.name"
                placeholder="例如：Docker 容器 / 核心告警"
                class="w-full px-3 py-1.5 text-sm rounded-lg border border-border bg-input text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-text-secondary mb-1">
                {{ t('styleCustomizer.groupDesc', '分组描述 (可选)') }}
              </label>
              <input
                type="text"
                v-model="groupForm.description"
                placeholder="说明该分组的匹配用途"
                class="w-full px-3 py-1.5 text-sm rounded-lg border border-border bg-input text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none"
              />
            </div>
          </div>

          <!-- 2. 分组样式与优先级设置 -->
          <div class="p-3 bg-muted/20 border border-border/50 rounded-lg space-y-2.5">
            <span class="text-xs font-semibold uppercase tracking-wider text-text-secondary block">
              共享样式与冲突优先级
            </span>
            <div class="flex items-center gap-3 flex-wrap">
              <!-- 拾色器与色盘 -->
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  v-model="groupForm.color"
                  class="w-7 h-7 rounded border border-border cursor-pointer p-0 bg-input shrink-0"
                />
                <input
                  type="text"
                  v-model="groupForm.color"
                  class="w-20 px-2 py-1 text-xs font-mono uppercase rounded border border-border bg-input text-foreground outline-none"
                />
                <div class="flex items-center gap-1">
                  <button
                    v-for="c in PALETTE_COLORS.slice(0, 5)"
                    :key="c"
                    type="button"
                    @click="groupForm.color = c"
                    class="w-5 h-5 rounded border border-border/80 transition-transform hover:scale-110"
                    :style="{ backgroundColor: c }"
                  ></button>
                </div>
              </div>

              <!-- 加粗与下划线 -->
              <div class="flex items-center gap-3 text-sm">
                <label class="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" v-model="groupForm.bold" class="rounded border-border text-primary focus:ring-primary" />
                  <span class="font-bold text-xs">加粗</span>
                </label>
                <label class="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" v-model="groupForm.underline" class="rounded border-border text-primary focus:ring-primary" />
                  <span class="underline text-xs">下划线</span>
                </label>
              </div>

              <!-- 优先级单选 -->
              <div class="flex items-center gap-1 text-xs ml-auto">
                <span class="text-text-secondary">优先级:</span>
                <button
                  type="button"
                  @click="groupForm.priority = 3"
                  :class="['px-2 py-0.5 rounded border text-[11px] font-medium transition-all', groupForm.priority === 3 ? 'bg-primary text-white border-primary' : 'bg-background border-border text-text-secondary']"
                >高</button>
                <button
                  type="button"
                  @click="groupForm.priority = 2"
                  :class="['px-2 py-0.5 rounded border text-[11px] font-medium transition-all', groupForm.priority === 2 ? 'bg-primary text-white border-primary' : 'bg-background border-border text-text-secondary']"
                >普通</button>
                <button
                  type="button"
                  @click="groupForm.priority = 1"
                  :class="['px-2 py-0.5 rounded border text-[11px] font-medium transition-all', groupForm.priority === 1 ? 'bg-primary text-white border-primary' : 'bg-background border-border text-text-secondary']"
                >低</button>
              </div>
            </div>
          </div>

          <!-- 3. 核心：匹配规则列表 (Matchers 自由组合区) -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-sm font-semibold text-foreground block">
                  匹配规则列表 (Matchers)
                </span>
                <span class="text-[11px] text-text-secondary">
                  支持添加任意数量、任意类型的规则，统一共享上方样式
                </span>
              </div>

              <!-- 添加三种类型 Matcher 快捷按钮组 -->
              <div class="flex items-center gap-1.5">
                <button
                  type="button"
                  @click="handleAddKeywordMatcher"
                  class="px-2.5 py-1 text-xs border border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary rounded-md font-medium transition-colors flex items-center gap-1"
                >
                  <i class="fas fa-tag text-[10px]"></i>
                  + 关键词
                </button>
                <button
                  type="button"
                  @click="handleAddRegexMatcher"
                  class="px-2.5 py-1 text-xs border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 rounded-md font-medium transition-colors flex items-center gap-1"
                >
                  <i class="fas fa-code text-[10px]"></i>
                  + 正则
                </button>
                <button
                  type="button"
                  @click="handleAddBuiltinMatcher"
                  class="px-2.5 py-1 text-xs border border-border bg-header hover:bg-muted text-foreground rounded-md font-medium transition-colors flex items-center gap-1"
                >
                  <i class="fas fa-shield-halved text-[10px]"></i>
                  + 内置分类
                </button>
              </div>
            </div>

            <!-- Matcher 规则条目卡片流 -->
            <div class="space-y-2 pt-1">
              <div
                v-for="(item, idx) in groupForm.matchers"
                :key="item.id"
                class="p-2.5 rounded-lg border border-border/80 bg-muted/15 flex items-center gap-2.5 text-xs transition-colors"
              >
                <!-- 规则类型微标签 -->
                <span
                  class="px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 uppercase border"
                  :class="[
                    item.type === 'builtin' ? 'bg-primary/10 text-primary border-primary/30' :
                    item.type === 'regex' ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' :
                    'bg-muted/80 text-foreground border-border'
                  ]"
                >
                  {{ item.type === 'builtin' ? '内置' : (item.type === 'regex' ? '正则' : '关键词') }}
                </span>

                <!-- 类型 1: 内置规则选择 -->
                <div v-if="item.type === 'builtin'" class="flex-1 min-w-0">
                  <select
                    v-model="item.builtinType"
                    class="w-full px-2.5 py-1 text-xs rounded border border-border bg-input text-foreground outline-none"
                  >
                    <option v-for="opt in BUILTIN_TYPE_OPTIONS" :key="opt.value" :value="opt.value">
                      {{ opt.label }}
                    </option>
                  </select>
                </div>

                <!-- 类型 2: 关键词输入及全词匹配/大小写开关 -->
                <div v-else-if="item.type === 'keyword'" class="flex-1 min-w-0 flex items-center gap-2">
                  <input
                    type="text"
                    v-model="item.keyword"
                    placeholder="输入匹配词，如 container"
                    class="flex-1 px-2.5 py-1 text-xs rounded border border-border bg-input text-foreground outline-none"
                  />
                  <label class="flex items-center gap-1 cursor-pointer shrink-0 text-text-secondary hover:text-foreground">
                    <input type="checkbox" v-model="item.wholeWord" class="rounded border-border text-primary text-[10px]" />
                    <span class="text-[11px]">全词</span>
                  </label>
                  <label class="flex items-center gap-1 cursor-pointer shrink-0 text-text-secondary hover:text-foreground">
                    <input type="checkbox" v-model="item.caseSensitive" class="rounded border-border text-primary text-[10px]" />
                    <span class="text-[11px]">区分大小写</span>
                  </label>
                </div>

                <!-- 类型 3: 正则表达式输入及报错展示 -->
                <div v-else-if="item.type === 'regex'" class="flex-1 min-w-0 space-y-1">
                  <div class="flex items-center gap-1">
                    <span class="text-primary font-mono text-xs select-none">/</span>
                    <input
                      type="text"
                      v-model="item.pattern"
                      @input="validateRegexItem(item)"
                      placeholder="输入正则表达式，如 exit code \d+"
                      class="flex-1 px-2 py-1 font-mono text-xs rounded border border-border bg-input text-foreground outline-none"
                    />
                    <span class="text-primary font-mono text-xs select-none">/g</span>
                  </div>
                  <p v-if="item.error" class="text-[10px] text-red-500 flex items-center gap-1">
                    <i class="fas fa-circle-exclamation text-[9px]"></i>
                    {{ item.error }}
                  </p>
                </div>

                <!-- 删除单条规则按钮 -->
                <button
                  type="button"
                  @click="handleRemoveMatcher(idx)"
                  class="w-6 h-6 rounded hover:bg-red-500/10 text-text-secondary hover:text-red-500 transition-colors flex items-center justify-center shrink-0"
                  title="移除此项"
                >
                  <i class="fas fa-trash-can text-xs"></i>
                </button>
              </div>

              <!-- 空列表占位 -->
              <div v-if="groupForm.matchers.length === 0" class="p-4 border border-dashed border-border rounded-lg text-center text-text-secondary text-xs">
                暂无匹配规则，请点击上方按钮添加关键词、正则表达式或内置分类
              </div>
            </div>
          </div>
        </div>

        <!-- 弹窗底栏 -->
        <footer class="px-5 py-3 border-t border-border bg-footer/60 flex justify-end gap-2.5 shrink-0">
          <button
            @click="isEditModalOpen = false"
            class="px-4 py-1.5 text-xs border border-border rounded-lg bg-background hover:bg-muted text-text-secondary transition-colors"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            @click="handleSaveGroup"
            :disabled="!groupForm.name.trim()"
            class="px-4 py-1.5 text-xs font-semibold rounded-lg bg-button text-button-text hover:bg-button-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ t('common.save', '保存分组') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>
