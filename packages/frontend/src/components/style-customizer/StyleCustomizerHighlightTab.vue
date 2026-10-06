<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '../common/ToggleSwitch.vue';
import { useTerminalHighlightStore } from '../../stores/terminal-highlight.store';
import type { TerminalHighlightGroup, HighlightPriority, HighlightMatchType } from '../../types/terminal-highlight.types';
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
const isEditingBuiltin = ref(false);

const groupForm = ref<{
  name: string;
  description: string;
  matchType: HighlightMatchType;
  keywordsInput: string;
  keywords: string[];
  patternsInput: string;
  color: string;
  bold: boolean;
  underline: boolean;
  priority: HighlightPriority;
  flags: string;
}>({
  name: '',
  description: '',
  matchType: 'keywords',
  keywordsInput: '',
  keywords: [],
  patternsInput: '',
  color: '#3b82f6',
  bold: false,
  underline: false,
  priority: 2,
  flags: 'g',
});

const regexError = ref<string | null>(null);

// 校验正则表达式
const validateRegex = (patternStr: string, flags: string): boolean => {
  if (!patternStr.trim()) {
    regexError.value = null;
    return true;
  }
  const lines = patternStr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  try {
    const f = flags && flags.includes('g') ? flags : `${flags || ''}g`;
    for (const p of lines) {
      new RegExp(p, f);
    }
    regexError.value = null;
    return true;
  } catch (err: any) {
    regexError.value = err.message || '无效的正则表达式语法';
    return false;
  }
};

// 打开新建分组弹窗
const handleOpenAddModal = () => {
  editingGroupId.value = null;
  isEditingBuiltin.value = false;
  groupForm.value = {
    name: '',
    description: '',
    matchType: 'keywords',
    keywordsInput: '',
    keywords: [],
    patternsInput: '',
    color: '#3b82f6',
    bold: false,
    underline: false,
    priority: 2,
    flags: 'g',
  };
  regexError.value = null;
  isEditModalOpen.value = true;
};

// 打开编辑弹窗
const handleOpenEditModal = (group: TerminalHighlightGroup) => {
  editingGroupId.value = group.id;
  isEditingBuiltin.value = !!group.isBuiltin;
  groupForm.value = {
    name: group.name,
    description: group.description || '',
    matchType: group.matchType || (group.patterns && group.patterns.length > 0 ? 'regex' : 'keywords'),
    keywordsInput: '',
    keywords: [...(group.keywords || [])],
    patternsInput: (group.patterns || []).join('\n'),
    color: group.color,
    bold: !!group.bold,
    underline: !!group.underline,
    priority: group.priority || 2,
    flags: group.flags || 'g',
  };
  regexError.value = null;
  isEditModalOpen.value = true;
};

// 添加单个关键词标签
const handleAddKeywordFromInput = () => {
  const raw = groupForm.value.keywordsInput.trim();
  if (!raw) return;

  // 支持以空格或逗号分割批量添加
  const tokens = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const token of tokens) {
    if (!groupForm.value.keywords.includes(token)) {
      groupForm.value.keywords.push(token);
    }
  }
  groupForm.value.keywordsInput = '';
};

// 删除单个关键词标签
const handleRemoveKeyword = (index: number) => {
  groupForm.value.keywords.splice(index, 1);
};

// 保存分组
const handleSaveGroup = () => {
  if (!groupForm.value.name.trim()) return;

  // 保证未按回车的关键词输入被收纳
  if (groupForm.value.matchType === 'keywords' && groupForm.value.keywordsInput.trim()) {
    handleAddKeywordFromInput();
  }

  // 正则模式校验
  if (groupForm.value.matchType === 'regex') {
    if (!validateRegex(groupForm.value.patternsInput, groupForm.value.flags)) {
      return;
    }
  }

  const patterns = groupForm.value.patternsInput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (editingGroupId.value) {
    highlightStore.updateGroup(editingGroupId.value, {
      name: groupForm.value.name.trim(),
      description: groupForm.value.description.trim(),
      matchType: groupForm.value.matchType,
      keywords: groupForm.value.keywords,
      patterns,
      color: groupForm.value.color,
      bold: groupForm.value.bold,
      underline: groupForm.value.underline,
      priority: groupForm.value.priority,
      flags: groupForm.value.flags,
    });
  } else {
    highlightStore.addGroup({
      name: groupForm.value.name.trim(),
      description: groupForm.value.description.trim(),
      enabled: true,
      matchType: groupForm.value.matchType,
      keywords: groupForm.value.keywords,
      patterns,
      color: groupForm.value.color,
      bold: groupForm.value.bold,
      underline: groupForm.value.underline,
      priority: groupForm.value.priority,
      flags: groupForm.value.flags,
    });
  }

  isEditModalOpen.value = false;
};

// 恢复预设
const handleResetToDefault = () => {
  if (confirm(t('styleCustomizer.confirmResetHighlight', '确定恢复为系统内置预设高亮分组？自定义分组将被清空。'))) {
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
          基于语义分类与区间仲裁装配
        </span>
      </div>

      <div class="divide-y divide-border/30">
        <div
          v-for="(group, index) in highlightStore.groups"
          :key="group.id"
          class="p-3.5 hover:bg-muted/15 transition-colors space-y-2.5"
        >
          <!-- 卡片头部：开关 + 标题 + 标签 + 样式与操作按钮组 -->
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

              <!-- 内置 / 自定义徽章 -->
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
                title="编辑分组"
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

          <!-- 卡片内容：规则概览胶囊 -->
          <div class="pl-9 text-xs">
            <!-- 关键词模式展示标签胶囊 -->
            <div v-if="group.keywords && group.keywords.length > 0" class="flex flex-wrap items-center gap-1.5">
              <span
                v-for="(kw, kwIdx) in group.keywords"
                :key="kwIdx"
                class="px-2 py-0.5 rounded bg-muted/60 text-foreground font-mono text-[11px] border border-border/40"
              >
                {{ kw }}
              </span>
            </div>

            <!-- 正则表达式展示代码块 -->
            <div v-else-if="group.patterns && group.patterns.length > 0" class="space-y-1">
              <div
                v-for="(pat, patIdx) in group.patterns"
                :key="patIdx"
                class="bg-muted/40 border border-border/50 rounded-md px-3 py-1 flex items-center justify-between gap-2 font-mono text-xs"
              >
                <span class="text-primary font-semibold select-none">/</span>
                <span class="text-foreground flex-1 break-all select-all font-mono">{{ pat }}</span>
                <span class="text-primary font-semibold select-none">/{{ group.flags || 'g' }}</span>
              </div>
            </div>

            <!-- 内置语义说明 -->
            <p v-if="group.description" class="text-text-secondary text-[11px] mt-1">
              {{ group.description }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. 添加/编辑高亮分组 Modal 弹窗 -->
    <div
      v-if="isEditModalOpen"
      class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      @click.self="isEditModalOpen = false"
    >
      <div class="bg-background text-foreground rounded-xl shadow-2xl w-full max-w-lg border border-border overflow-hidden">
        <header class="px-5 py-3.5 border-b border-border bg-header/60 flex justify-between items-center">
          <h3 class="font-semibold text-base">
            {{ editingGroupId ? (isEditingBuiltin ? t('styleCustomizer.editBuiltinGroup', '调整内置高亮样式') : t('styleCustomizer.editGroup', '编辑高亮分组')) : t('styleCustomizer.createGroup', '新建高亮分组') }}
          </h3>
          <button @click="isEditModalOpen = false" class="text-text-secondary hover:text-foreground text-xl leading-none">&times;</button>
        </header>

        <div class="p-5 space-y-4 bg-background max-h-[75vh] overflow-y-auto">
          <!-- 分组名称 -->
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1.5">
              {{ t('styleCustomizer.groupName', '分组名称') }} *
            </label>
            <input
              type="text"
              v-model="groupForm.name"
              placeholder="例如：Docker 容器 / 业务微服务"
              class="w-full px-3.5 py-2 text-sm rounded-lg border border-border bg-input text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
          </div>

          <!-- 匹配方式选择 (内置分组锁定其模式) -->
          <div v-if="!isEditingBuiltin">
            <label class="block text-sm font-medium text-text-secondary mb-1.5">
              {{ t('styleCustomizer.matchType', '匹配方式') }}
            </label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                @click="groupForm.matchType = 'keywords'"
                :class="[
                  'py-2 px-3 text-sm rounded-lg border text-center transition-all flex items-center justify-center gap-2',
                  groupForm.matchType === 'keywords'
                    ? 'bg-primary/10 border-primary text-primary font-semibold'
                    : 'bg-muted/30 border-border text-text-secondary hover:text-foreground'
                ]"
              >
                <i class="fas fa-tags text-xs"></i>
                关键词 (推荐)
              </button>
              <button
                type="button"
                @click="groupForm.matchType = 'regex'"
                :class="[
                  'py-2 px-3 text-sm rounded-lg border text-center transition-all flex items-center justify-center gap-2',
                  groupForm.matchType === 'regex'
                    ? 'bg-primary/10 border-primary text-primary font-semibold'
                    : 'bg-muted/30 border-border text-text-secondary hover:text-foreground'
                ]"
              >
                <i class="fas fa-code text-xs"></i>
                正则表达式 (高级)
              </button>
            </div>
          </div>

          <!-- 关键词输入模式 -->
          <div v-if="groupForm.matchType === 'keywords' || (isEditingBuiltin && groupForm.keywords.length > 0)">
            <label class="block text-sm font-medium text-text-secondary mb-1.5">
              {{ t('styleCustomizer.keywords', '包含关键词') }}
            </label>

            <!-- 关键词输入栏 -->
            <div class="flex gap-2 mb-2">
              <input
                type="text"
                v-model="groupForm.keywordsInput"
                @keydown.enter.prevent="handleAddKeywordFromInput"
                placeholder="输入单词按回车添加 (如 container)"
                class="flex-1 px-3.5 py-2 text-sm rounded-lg border border-border bg-input text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none"
              />
              <button
                type="button"
                @click="handleAddKeywordFromInput"
                class="px-3.5 py-2 text-sm border border-border rounded-lg bg-header hover:bg-muted text-foreground transition-colors"
              >
                添加
              </button>
            </div>

            <!-- 已添加关键词标签列表 -->
            <div class="flex flex-wrap gap-1.5 min-h-[32px] p-2 bg-muted/20 border border-border/50 rounded-lg">
              <span
                v-for="(kw, idx) in groupForm.keywords"
                :key="idx"
                class="px-2.5 py-1 rounded bg-muted text-foreground text-xs font-mono flex items-center gap-1.5 border border-border/60"
              >
                {{ kw }}
                <button
                  type="button"
                  @click="handleRemoveKeyword(idx)"
                  class="text-text-secondary hover:text-red-500 text-xs"
                >&times;</button>
              </span>
              <span v-if="groupForm.keywords.length === 0" class="text-text-secondary text-xs self-center">
                暂无关键词，请在上方输入添加
              </span>
            </div>
          </div>

          <!-- 正则表达式模式 -->
          <div v-if="groupForm.matchType === 'regex' || (isEditingBuiltin && (!groupForm.keywords || groupForm.keywords.length === 0))">
            <label class="block text-sm font-medium text-text-secondary mb-1.5">
              {{ t('styleCustomizer.patterns', '正则表达式 (每行一条)') }}
            </label>
            <textarea
              v-model="groupForm.patternsInput"
              @input="validateRegex(groupForm.patternsInput, groupForm.flags)"
              placeholder="例如：\bexit code \d+\b"
              rows="3"
              class="w-full px-3.5 py-2 font-mono text-sm rounded-lg border border-border bg-input text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none resize-none"
            ></textarea>
            <p v-if="regexError" class="text-xs text-red-500 mt-1 flex items-center gap-1.5">
              <i class="fas fa-circle-exclamation text-xs"></i>
              {{ regexError }}
            </p>
          </div>

          <!-- 颜色选取与推荐色盘 -->
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1.5">
              {{ t('styleCustomizer.ruleColor', '高亮颜色') }}
            </label>
            <div class="flex items-center gap-2.5">
              <input
                type="color"
                v-model="groupForm.color"
                class="w-9 h-9 rounded-lg border border-border cursor-pointer p-0.5 bg-input shrink-0"
              />
              <input
                type="text"
                v-model="groupForm.color"
                class="w-24 px-2.5 py-2 text-sm font-mono uppercase rounded-lg border border-border bg-input text-foreground outline-none"
              />
              <!-- 快捷颜色色盘 -->
              <div class="flex items-center gap-1.5 flex-wrap">
                <button
                  v-for="c in PALETTE_COLORS"
                  :key="c"
                  type="button"
                  @click="groupForm.color = c"
                  class="w-6 h-6 rounded border border-border/80 transition-transform hover:scale-110"
                  :style="{ backgroundColor: c }"
                ></button>
              </div>
            </div>
          </div>

          <!-- 样式开关选项 -->
          <div class="flex items-center gap-6 pt-1">
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" v-model="groupForm.bold" class="rounded border-border text-primary focus:ring-primary" />
              <span class="font-bold">加粗 (Bold)</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" v-model="groupForm.underline" class="rounded border-border text-primary focus:ring-primary" />
              <span class="underline">下划线 (Underline)</span>
            </label>
          </div>

          <!-- 优先级配置 (仅非内置分组展示) -->
          <div v-if="!isEditingBuiltin">
            <label class="block text-sm font-medium text-text-secondary mb-1.5">
              {{ t('styleCustomizer.priority', '匹配优先级 (重叠冲突仲裁)') }}
            </label>
            <div class="grid grid-cols-3 gap-2">
              <button
                type="button"
                @click="groupForm.priority = 3"
                :class="[
                  'py-1.5 px-2 text-xs rounded-md border text-center transition-all',
                  groupForm.priority === 3 ? 'bg-primary/10 border-primary text-primary font-semibold' : 'bg-muted/30 border-border text-text-secondary'
                ]"
              >
                高 (优先锁定)
              </button>
              <button
                type="button"
                @click="groupForm.priority = 2"
                :class="[
                  'py-1.5 px-2 text-xs rounded-md border text-center transition-all',
                  groupForm.priority === 2 ? 'bg-primary/10 border-primary text-primary font-semibold' : 'bg-muted/30 border-border text-text-secondary'
                ]"
              >
                普通 (标准)
              </button>
              <button
                type="button"
                @click="groupForm.priority = 1"
                :class="[
                  'py-1.5 px-2 text-xs rounded-md border text-center transition-all',
                  groupForm.priority === 1 ? 'bg-primary/10 border-primary text-primary font-semibold' : 'bg-muted/30 border-border text-text-secondary'
                ]"
              >
                低 (次要词组)
              </button>
            </div>
          </div>
        </div>

        <footer class="px-5 py-3 border-t border-border bg-footer/60 flex justify-end gap-2.5">
          <button
            @click="isEditModalOpen = false"
            class="px-4 py-2 text-sm border border-border rounded-lg bg-background hover:bg-muted text-text-secondary transition-colors"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            @click="handleSaveGroup"
            :disabled="!groupForm.name.trim() || !!regexError"
            class="px-4 py-2 text-sm font-semibold rounded-lg bg-button text-button-text hover:bg-button-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ t('common.save', '保存分组') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>
