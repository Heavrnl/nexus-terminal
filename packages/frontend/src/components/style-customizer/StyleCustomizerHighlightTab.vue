<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useAppearanceStore } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import type { TerminalKeywordHighlightRule } from '../../types/terminal-highlight.types';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

const { terminalHighlightEnabled, terminalHighlightRules } = storeToRefs(appearanceStore);

// 编辑模态框状态
const isModalOpen = ref(false);
const editingRuleId = ref<string | null>(null);

const formName = ref('');
const formPattern = ref('');
const formIsRegex = ref(true);
const formIsCaseSensitive = ref(false);
const formColor = ref('#10b981');
const formBgColor = ref('');
const formEnabled = ref(true);
const formError = ref('');

// 快速调色板候选
const presetPalette = [
  '#10b981', // 翡翠绿
  '#22c55e', // 鲜绿
  '#ef4444', // 醒目红
  '#f59e0b', // 琥珀黄
  '#06b6d4', // 科技青
  '#3b82f6', // 经典蓝
  '#a855f7', // 魅惑紫
  '#ec4899', // 亮粉红
  '#f97316', // 活力橙
  '#e2e8f0', // 柔白
];

// 切换全局高亮总开关
const handleToggleGlobalEnabled = async () => {
  try {
    const nextVal = !terminalHighlightEnabled.value;
    await appearanceStore.setTerminalHighlightEnabled(nextVal);
    notificationsStore.addNotification({
      type: 'success',
      message: nextVal
        ? t('styleCustomizer.highlightGlobalEnabled', '终端智能关键字高亮已启用')
        : t('styleCustomizer.highlightGlobalDisabled', '终端智能关键字高亮已禁用'),
    });
  } catch (error: any) {
    notificationsStore.addNotification({
      type: 'error',
      message: error.message || t('common.error', '操作失败'),
    });
  }
};

// 单条规则启闭切换
const handleToggleRuleEnabled = async (rule: TerminalKeywordHighlightRule) => {
  try {
    const updated = terminalHighlightRules.value.map(r => {
      if (r.id === rule.id) {
        return { ...r, enabled: !r.enabled };
      }
      return r;
    });
    await appearanceStore.setTerminalHighlightRules(updated);
  } catch (error: any) {
    notificationsStore.addNotification({
      type: 'error',
      message: error.message || t('common.error', '更新规则状态失败'),
    });
  }
};

// 打开新建模态框
const handleOpenAddModal = () => {
  editingRuleId.value = null;
  formName.value = '';
  formPattern.value = '';
  formIsRegex.value = false;
  formIsCaseSensitive.value = false;
  formColor.value = '#10b981';
  formBgColor.value = '';
  formEnabled.value = true;
  formError.value = '';
  isModalOpen.value = true;
};

// 打开编辑模态框
const handleOpenEditModal = (rule: TerminalKeywordHighlightRule) => {
  editingRuleId.value = rule.id;
  formName.value = rule.name;
  formPattern.value = rule.pattern;
  formIsRegex.value = rule.isRegex;
  formIsCaseSensitive.value = rule.isCaseSensitive ?? false;
  formColor.value = rule.color;
  formBgColor.value = rule.bgColor || '';
  formEnabled.value = rule.enabled;
  formError.value = '';
  isModalOpen.value = true;
};

// 删除规则
const handleDeleteRule = async (ruleId: string) => {
  try {
    const updated = terminalHighlightRules.value.filter(r => r.id !== ruleId);
    await appearanceStore.setTerminalHighlightRules(updated);
    notificationsStore.addNotification({
      type: 'success',
      message: t('styleCustomizer.ruleDeletedSuccess', '高亮规则已删除'),
    });
  } catch (error: any) {
    notificationsStore.addNotification({
      type: 'error',
      message: error.message || t('common.error', '删除规则失败'),
    });
  }
};

// 恢复默认预设
const handleResetToDefault = async () => {
  try {
    await appearanceStore.resetTerminalHighlightRulesToDefault();
    notificationsStore.addNotification({
      type: 'success',
      message: t('styleCustomizer.rulesResetSuccess', '已恢复默认预设规则列表'),
    });
  } catch (error: any) {
    notificationsStore.addNotification({
      type: 'error',
      message: error.message || t('common.error', '恢复默认失败'),
    });
  }
};

// 保存规则 (新建或修改)
const handleSaveRule = async () => {
  if (!formName.value.trim()) {
    formError.value = t('styleCustomizer.ruleNameRequired', '请输入规则名称');
    return;
  }
  if (!formPattern.value.trim()) {
    formError.value = t('styleCustomizer.rulePatternRequired', '请输入匹配关键字或正则表达式');
    return;
  }

  // 若选择正则，校验语法合法性
  if (formIsRegex.value) {
    try {
      new RegExp(formPattern.value.trim());
    } catch (e: any) {
      formError.value = t('styleCustomizer.invalidRegexError', '正则表达式语法无效: ') + e.message;
      return;
    }
  }

  const currentRules = [...terminalHighlightRules.value];

  if (editingRuleId.value) {
    // 编辑
    const index = currentRules.findIndex(r => r.id === editingRuleId.value);
    if (index !== -1) {
      currentRules[index] = {
        ...currentRules[index],
        name: formName.value.trim(),
        pattern: formPattern.value.trim(),
        isRegex: formIsRegex.value,
        isCaseSensitive: formIsCaseSensitive.value,
        color: formColor.value,
        bgColor: formBgColor.value.trim(),
        enabled: formEnabled.value,
      };
    }
  } else {
    // 新增
    const newRule: TerminalKeywordHighlightRule = {
      id: `custom-rule-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      name: formName.value.trim(),
      pattern: formPattern.value.trim(),
      isRegex: formIsRegex.value,
      isCaseSensitive: formIsCaseSensitive.value,
      color: formColor.value,
      bgColor: formBgColor.value.trim(),
      enabled: formEnabled.value,
      isPreset: false,
    };
    currentRules.push(newRule);
  }

  try {
    await appearanceStore.setTerminalHighlightRules(currentRules);
    notificationsStore.addNotification({
      type: 'success',
      message: t('common.saved', '已保存'),
    });
    isModalOpen.value = false;
  } catch (error: any) {
    formError.value = error.message || t('common.error', '保存失败');
  }
};
</script>

<template>
  <section class="space-y-5">
    <div class="border-b border-border pb-3">
      <h3 class="m-0 text-lg font-semibold text-foreground flex items-center gap-2">
        <i class="fas fa-highlighter text-primary"></i>
        {{ t('styleCustomizer.highlightTab', '终端关键字高亮') }}
      </h3>
      <p class="text-xs text-text-secondary mt-1 leading-relaxed">
        {{ t('styleCustomizer.highlightTabDesc', '自动对终端输出内容中的状态词、错误日志、IP网络与自定义关键词进行本地智能着色，便于直观识别') }}
      </p>
    </div>

    <!-- 全局总开关卡片 -->
    <div class="p-3.5 bg-header/40 border border-border rounded-xl flex items-center justify-between gap-4">
      <div>
        <div class="text-sm font-semibold text-foreground flex items-center gap-2">
          <span>{{ t('styleCustomizer.enableKeywordHighlight', '启用终端关键字智能高亮') }}</span>
          <span
            v-if="terminalHighlightEnabled"
            class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/15 text-primary border border-primary/20"
          >
            RUNNING
          </span>
        </div>
        <p class="text-xs text-text-secondary mt-0.5">
          {{ t('styleCustomizer.enableKeywordHighlightHint', '开启后，终端接收到匹配文本时将自动呈现醒目层次色彩') }}
        </p>
      </div>

      <button
        type="button"
        @click="handleToggleGlobalEnabled"
        :class="[
          'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-primary',
          terminalHighlightEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
        ]"
        role="switch"
        :aria-checked="terminalHighlightEnabled"
      >
        <span
          aria-hidden="true"
          :class="[
            'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
            terminalHighlightEnabled ? 'translate-x-5' : 'translate-x-0'
          ]"
        ></span>
      </button>
    </div>

    <!-- 工具栏：操作按钮 -->
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="text-xs text-text-secondary font-medium">
        {{ t('styleCustomizer.ruleCountInfo', { count: terminalHighlightRules.length }) }}
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="handleResetToDefault"
          class="px-3 py-1.5 text-xs border border-border rounded-lg bg-header hover:bg-border transition text-foreground flex items-center gap-1.5"
          :title="t('styleCustomizer.resetRulesTooltip', '恢复系统默认规则配置')"
        >
          <i class="fas fa-undo text-[11px] text-text-secondary"></i>
          {{ t('styleCustomizer.resetToDefaultRules', '恢复预设') }}
        </button>

        <button
          type="button"
          @click="handleOpenAddModal"
          class="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition shadow-2xs flex items-center gap-1.5"
        >
          <i class="fas fa-plus text-[11px]"></i>
          {{ t('styleCustomizer.addCustomRule', '添加规则') }}
        </button>
      </div>
    </div>

    <!-- 规则列表 -->
    <div class="space-y-2.5">
      <div
        v-for="rule in terminalHighlightRules"
        :key="rule.id"
        class="p-3 bg-background border border-border rounded-xl transition hover:border-primary/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
      >
        <!-- 规则基础信息与效果预览 -->
        <div class="flex-1 min-w-0 pr-2">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-semibold text-foreground truncate">{{ rule.name }}</span>
            <span
              :class="[
                'text-[10px] px-1.5 py-0.5 rounded border font-mono font-medium',
                rule.isRegex
                  ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20'
                  : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
              ]"
            >
              {{ rule.isRegex ? 'Regex' : 'Keyword' }}
            </span>
            <span
              v-if="rule.isPreset"
              class="text-[10px] px-1.5 py-0.5 rounded bg-muted text-text-secondary border border-border"
            >
              {{ t('styleCustomizer.presetBadge', '预设') }}
            </span>
          </div>

          <!-- 模式与着色效果预览 Badge -->
          <div class="mt-2 flex items-center gap-2.5 flex-wrap">
            <span
              class="px-2.5 py-1 rounded text-xs font-mono font-bold shadow-2xs border border-white/10"
              :style="{
                color: rule.color,
                backgroundColor: rule.bgColor || 'rgba(0, 0, 0, 0.45)',
              }"
            >
              Aa 示例预览
            </span>

            <code class="text-xs text-text-secondary font-mono bg-muted/60 px-2 py-0.5 rounded border border-border/60 truncate max-w-[280px] sm:max-w-[340px]">
              {{ rule.pattern }}
            </code>
          </div>
        </div>

        <!-- 右侧开关与编辑按钮 -->
        <div class="flex items-center gap-2 self-end sm:self-center shrink-0">
          <!-- 单条启用/停用开关 -->
          <button
            type="button"
            @click="handleToggleRuleEnabled(rule)"
            :class="[
              'relative inline-flex flex-shrink-0 h-5 w-9 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none',
              rule.enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
            ]"
            role="switch"
            :aria-checked="rule.enabled"
            :title="rule.enabled ? '已启用' : '已停用'"
          >
            <span
              aria-hidden="true"
              :class="[
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
                rule.enabled ? 'translate-x-4' : 'translate-x-0'
              ]"
            ></span>
          </button>

          <!-- 编辑按钮 -->
          <button
            type="button"
            @click="handleOpenEditModal(rule)"
            class="w-7 h-7 rounded-lg border border-border bg-header hover:bg-border text-foreground transition flex items-center justify-center text-xs"
            :title="t('common.edit', '编辑')"
          >
            <i class="fas fa-pen"></i>
          </button>

          <!-- 删除按钮 -->
          <button
            type="button"
            @click="handleDeleteRule(rule.id)"
            class="w-7 h-7 rounded-lg border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-500 transition flex items-center justify-center text-xs"
            :title="t('common.delete', '删除')"
          >
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- 弹窗：新建 / 编辑规则模态框 -->
    <div
      v-if="isModalOpen"
      class="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
      @click.self="isModalOpen = false"
    >
      <div class="bg-background text-foreground border border-border rounded-2xl shadow-xl w-full max-w-[500px] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        <div class="px-5 py-4 border-b border-border bg-header flex items-center justify-between">
          <h4 class="m-0 text-base font-semibold text-foreground flex items-center gap-2">
            <i class="fas fa-palette text-primary"></i>
            {{ editingRuleId ? t('styleCustomizer.editRuleTitle', '编辑高亮规则') : t('styleCustomizer.addRuleTitle', '添加高亮规则') }}
          </h4>
          <button
            type="button"
            @click="isModalOpen = false"
            class="text-text-secondary hover:text-foreground text-lg leading-none cursor-pointer p-1"
          >
            &times;
          </button>
        </div>

        <div class="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          <div v-if="formError" class="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
            {{ formError }}
          </div>

          <!-- 规则名称 -->
          <div>
            <label class="block text-xs font-semibold text-foreground mb-1">
              {{ t('styleCustomizer.ruleNameLabel', '规则名称') }} *
            </label>
            <input
              type="text"
              v-model="formName"
              placeholder="例如：Docker 退出状态 / 错误日志"
              class="w-full h-9 px-3 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>

          <!-- 匹配类型切换 -->
          <div class="flex items-center gap-4">
            <label class="inline-flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer">
              <input type="radio" :value="false" v-model="formIsRegex" class="text-primary focus:ring-primary" />
              <span>普通关键字 (逗号/空格分隔)</span>
            </label>
            <label class="inline-flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer">
              <input type="radio" :value="true" v-model="formIsRegex" class="text-primary focus:ring-primary" />
              <span>正则表达式 (Regex)</span>
            </label>
          </div>

          <!-- 匹配模式输入框 -->
          <div>
            <label class="block text-xs font-semibold text-foreground mb-1">
              {{ formIsRegex ? t('styleCustomizer.regexPatternLabel', '正则表达式') : t('styleCustomizer.keywordsLabel', '关键词列表') }} *
            </label>
            <input
              type="text"
              v-model="formPattern"
              :placeholder="formIsRegex ? '\\b(ERROR|FAIL|FATAL)\\b' : 'ERROR, FAIL, FATAL'"
              class="w-full h-9 px-3 text-sm font-mono border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
            <p class="text-[11px] text-text-secondary mt-1">
              {{ formIsRegex ? '填写标准 JavaScript 正则表达式表达式。' : '多个关键词可用中英文逗号、竖线或空格隔开。' }}
            </p>
          </div>

          <!-- 颜色配置 -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <!-- 前景色 -->
            <div>
              <label class="block text-xs font-semibold text-foreground mb-1">
                {{ t('styleCustomizer.ruleForegroundColor', '文字前景色') }}
              </label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  v-model="formColor"
                  class="p-0.5 h-9 w-11 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  v-model="formColor"
                  class="flex-1 h-9 px-2 text-xs font-mono border border-border rounded-lg bg-background text-foreground uppercase"
                />
              </div>
            </div>

            <!-- 背景色 (可选) -->
            <div>
              <label class="block text-xs font-semibold text-foreground mb-1">
                {{ t('styleCustomizer.ruleBackgroundColor', '背景色 (可选)') }}
              </label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  v-model="formBgColor"
                  class="p-0.5 h-9 w-11 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  v-model="formBgColor"
                  placeholder="#000000 / 留空"
                  class="flex-1 h-9 px-2 text-xs font-mono border border-border rounded-lg bg-background text-foreground uppercase"
                />
              </div>
            </div>
          </div>

          <!-- 快速调色板推荐 -->
          <div>
            <span class="block text-[11px] text-text-secondary mb-1.5">快速色板直选：</span>
            <div class="flex items-center gap-1.5 flex-wrap">
              <button
                v-for="color in presetPalette"
                :key="color"
                type="button"
                @click="formColor = color"
                class="w-6 h-6 rounded-full border border-border/80 transition transform hover:scale-110 shadow-2xs"
                :style="{ backgroundColor: color }"
                :title="color"
              ></button>
            </div>
          </div>

          <!-- 实时效果预览胶囊 -->
          <div class="p-3 bg-muted/40 border border-border rounded-xl">
            <span class="block text-[11px] text-text-secondary mb-1.5 font-medium">效果即时预览：</span>
            <div class="flex items-center gap-2">
              <span
                class="px-3 py-1.5 rounded-md text-sm font-mono font-bold shadow-2xs border border-white/10"
                :style="{
                  color: formColor,
                  backgroundColor: formBgColor || 'rgba(0, 0, 0, 0.5)',
                }"
              >
                {{ formPattern ? (formIsRegex ? 'PREVIEW-MATCH' : formPattern.split(/[,，|\s]+/)[0] || 'PREVIEW') : 'MATCH_TEXT' }}
              </span>
              <span class="text-xs text-text-secondary font-mono">0.0.0.0:80->80/tcp [示例普通文字]</span>
            </div>
          </div>
        </div>

        <!-- 模态框底部按钮 -->
        <div class="px-5 py-3.5 border-t border-border bg-footer flex items-center justify-end gap-2">
          <button
            type="button"
            @click="isModalOpen = false"
            class="px-4 py-1.5 text-sm border border-border rounded-lg bg-header hover:bg-border text-foreground transition"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            @click="handleSaveRule"
            class="px-4 py-1.5 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition shadow-2xs"
          >
            {{ t('common.save', '保存') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
