<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '../common/ToggleSwitch.vue';
import { useTerminalHighlightStore } from '../../stores/terminal-highlight.store';
import type { TerminalHighlightRule } from '../../types/terminal-highlight.types';
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
2026-10-06 18:30:15 [INFO] 192.168.1.100 GET https://nexus.example.com/api/v1/health 200 OK
2026-10-06 18:30:16 [WARN] Slow database query from 10.0.0.8:5432, duration: 1820ms
2026-10-06 18:30:17 [ERROR] Connection refused to 172.16.0.4:6379, retry 3 of 5 failed!`,

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

// 编辑与新增弹窗状态
const isEditModalOpen = ref(false);
const editingRuleId = ref<string | null>(null);
const ruleForm = ref({
  name: '',
  pattern: '',
  flags: 'g',
  color: '#22c55e',
  bold: false,
  underline: false,
});
const regexError = ref<string | null>(null);

const validateRegex = (pattern: string, flags: string): boolean => {
  try {
    const f = flags && flags.includes('g') ? flags : `${flags || ''}g`;
    new RegExp(pattern, f);
    regexError.value = null;
    return true;
  } catch (err: any) {
    regexError.value = err.message || '无效的正则表达式语法';
    return false;
  }
};

const handleOpenAddModal = () => {
  editingRuleId.value = null;
  ruleForm.value = {
    name: '',
    pattern: '',
    flags: 'g',
    color: '#3b82f6',
    bold: false,
    underline: false,
  };
  regexError.value = null;
  isEditModalOpen.value = true;
};

const handleOpenEditModal = (rule: TerminalHighlightRule) => {
  editingRuleId.value = rule.id;
  ruleForm.value = {
    name: rule.name,
    pattern: rule.pattern,
    flags: rule.flags || 'g',
    color: rule.color,
    bold: !!rule.bold,
    underline: !!rule.underline,
  };
  regexError.value = null;
  isEditModalOpen.value = true;
};

const handleSaveRule = () => {
  if (!ruleForm.value.name.trim()) return;
  if (!ruleForm.value.pattern.trim()) return;

  if (!validateRegex(ruleForm.value.pattern, ruleForm.value.flags)) {
    return;
  }

  if (editingRuleId.value) {
    highlightStore.updateRule(editingRuleId.value, {
      name: ruleForm.value.name.trim(),
      pattern: ruleForm.value.pattern.trim(),
      flags: ruleForm.value.flags,
      color: ruleForm.value.color,
      bold: ruleForm.value.bold,
      underline: ruleForm.value.underline,
    });
  } else {
    highlightStore.addRule({
      name: ruleForm.value.name.trim(),
      pattern: ruleForm.value.pattern.trim(),
      flags: ruleForm.value.flags,
      color: ruleForm.value.color,
      bold: ruleForm.value.bold,
      underline: ruleForm.value.underline,
      enabled: true,
    });
  }
  isEditModalOpen.value = false;
};

const handleResetToDefault = () => {
  if (confirm(t('styleCustomizer.confirmResetHighlight', '确定恢复默认预设高亮规则？'))) {
    highlightStore.resetToDefault();
  }
};
</script>

<template>
  <div class="space-y-3.5 pb-4">
    <!-- 1. 紧凑顶部控制栏 -->
    <div class="bg-header/40 border border-border rounded-lg px-3.5 py-2.5 flex items-center justify-between gap-3 shadow-2xs">
      <div class="flex items-center gap-2.5">
        <span class="text-sm font-semibold text-foreground">
          {{ t('styleCustomizer.highlightTitle', '终端代码高亮') }}
        </span>
        <ToggleSwitch
          size="sm"
          :model-value="highlightStore.enabled"
          @update:model-value="highlightStore.toggleEnabled"
          aria-label="启用终端代码高亮"
        />
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="handleResetToDefault"
          class="px-2.5 py-1 text-xs border border-border rounded bg-background hover:bg-muted text-text-secondary hover:text-foreground transition-colors flex items-center gap-1"
          :title="t('styleCustomizer.resetHighlightTitle', '恢复经典预设规则')"
        >
          <i class="fas fa-rotate-left text-[10px]"></i>
          {{ t('styleCustomizer.resetDefault', '恢复预设') }}
        </button>
        <button
          @click="handleOpenAddModal"
          class="px-2.5 py-1 text-xs border border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors font-medium flex items-center gap-1"
        >
          <i class="fas fa-plus text-[10px]"></i>
          {{ t('styleCustomizer.addRule', '添加规则') }}
        </button>
      </div>
    </div>

    <!-- 2. 精简实时预览窗口 -->
    <div class="border border-border rounded-lg overflow-hidden shadow-2xs bg-[#12141a]">
      <div class="px-3 py-1.5 border-b border-border/40 bg-[#1a1d24] flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-red-500/80 inline-block"></span>
          <span class="w-2 h-2 rounded-full bg-yellow-500/80 inline-block"></span>
          <span class="w-2 h-2 rounded-full bg-green-500/80 inline-block"></span>
          <span class="text-[11px] font-mono text-gray-400 ml-1.5">{{ t('styleCustomizer.livePreview', '效果预览') }}</span>
        </div>

        <div class="flex items-center gap-1">
          <button
            @click="currentSample = 'docker'"
            :class="['px-2 py-0.5 text-[11px] rounded transition-colors font-medium', currentSample === 'docker' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white']"
          >
            Docker
          </button>
          <button
            @click="currentSample = 'log'"
            :class="['px-2 py-0.5 text-[11px] rounded transition-colors font-medium', currentSample === 'log' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white']"
          >
            Logs
          </button>
          <button
            @click="currentSample = 'network'"
            :class="['px-2 py-0.5 text-[11px] rounded transition-colors font-medium', currentSample === 'network' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white']"
          >
            Network
          </button>
        </div>
      </div>

      <div class="p-2.5 font-mono text-xs leading-normal text-gray-200 overflow-x-auto whitespace-pre max-h-36">
        <div v-html="previewHtml"></div>
      </div>
    </div>

    <!-- 3. 紧凑规则列表 -->
    <div class="border border-border rounded-lg overflow-hidden bg-background shadow-2xs">
      <div class="px-3 py-2 border-b border-border bg-header/30 flex items-center justify-between">
        <span class="text-xs font-semibold text-foreground">
          {{ t('styleCustomizer.rulesList', '高亮规则') }}
          <span class="font-normal text-text-secondary">({{ highlightStore.rules.length }})</span>
        </span>
      </div>

      <div class="divide-y divide-border/30">
        <div
          v-for="(rule, index) in highlightStore.rules"
          :key="rule.id"
          class="px-3 py-2 hover:bg-muted/15 transition-colors flex items-center justify-between gap-3 text-xs"
        >
          <!-- 左侧：开关 + 名称 + 正则表达式 -->
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <ToggleSwitch
              size="sm"
              :model-value="rule.enabled"
              @update:model-value="(val) => highlightStore.toggleRule(rule.id, val)"
              :aria-label="`启用 ${rule.name}`"
            />

            <span class="font-medium text-foreground truncate max-w-[150px] sm:max-w-[180px]" :class="{ 'opacity-50': !rule.enabled }">
              {{ rule.name }}
            </span>

            <code class="px-1.5 py-0.5 rounded bg-muted/60 text-text-secondary font-mono truncate max-w-[200px] sm:max-w-[320px] text-[11px] border border-border/30">
              {{ rule.pattern }}
            </code>
          </div>

          <!-- 右侧：样式控制与操作按钮 -->
          <div class="flex items-center gap-1.5 shrink-0">
            <!-- 原生颜色选择器色块 -->
            <label class="relative cursor-pointer w-6 h-6 rounded border border-border overflow-hidden shadow-2xs flex items-center justify-center shrink-0" :title="t('styleCustomizer.pickColor', '选择颜色')">
              <input
                type="color"
                v-model="rule.color"
                class="absolute -top-4 -left-4 w-14 h-14 cursor-pointer opacity-0"
              />
              <span class="w-full h-full" :style="{ backgroundColor: rule.color }"></span>
            </label>

            <!-- 加粗开关 -->
            <button
              @click="rule.bold = !rule.bold"
              :class="[
                'w-6 h-6 rounded text-[11px] font-bold border transition-colors flex items-center justify-center',
                rule.bold ? 'bg-primary text-white border-primary' : 'bg-background text-text-secondary border-border hover:bg-muted'
              ]"
              title="加粗"
            >
              B
            </button>

            <!-- 下划线开关 -->
            <button
              @click="rule.underline = !rule.underline"
              :class="[
                'w-6 h-6 rounded text-[11px] underline border transition-colors flex items-center justify-center font-serif',
                rule.underline ? 'bg-primary text-white border-primary' : 'bg-background text-text-secondary border-border hover:bg-muted'
              ]"
              title="下划线"
            >
              U
            </button>

            <!-- 排序 (上移/下移) -->
            <button
              @click="highlightStore.moveRule(index, index - 1)"
              :disabled="index === 0"
              class="w-6 h-6 text-text-secondary hover:text-foreground hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed rounded border border-border flex items-center justify-center transition-colors"
              title="上移"
            >
              <i class="fas fa-chevron-up text-[9px]"></i>
            </button>
            <button
              @click="highlightStore.moveRule(index, index + 1)"
              :disabled="index === highlightStore.rules.length - 1"
              class="w-6 h-6 text-text-secondary hover:text-foreground hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed rounded border border-border flex items-center justify-center transition-colors"
              title="下移"
            >
              <i class="fas fa-chevron-down text-[9px]"></i>
            </button>

            <!-- 编辑 -->
            <button
              @click="handleOpenEditModal(rule)"
              class="w-6 h-6 rounded border border-border bg-background hover:bg-muted text-text-secondary hover:text-foreground transition-colors flex items-center justify-center"
              title="编辑"
            >
              <i class="fas fa-pen text-[10px]"></i>
            </button>

            <!-- 删除 -->
            <button
              @click="highlightStore.deleteRule(rule.id)"
              class="w-6 h-6 rounded border border-border bg-background hover:bg-red-500/10 text-text-secondary hover:text-red-500 transition-colors flex items-center justify-center"
              title="删除"
            >
              <i class="fas fa-trash-can text-[10px]"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. 添加/编辑规则 Modal 对话框 (实色不透明背景) -->
    <div
      v-if="isEditModalOpen"
      class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      @click.self="isEditModalOpen = false"
    >
      <div class="bg-background text-foreground rounded-xl shadow-2xl w-full max-w-md border border-border overflow-hidden">
        <header class="px-4 py-3 border-b border-border bg-header/60 flex justify-between items-center">
          <h3 class="font-semibold text-sm">
            {{ editingRuleId ? t('styleCustomizer.editRule', '编辑规则') : t('styleCustomizer.createRule', '添加规则') }}
          </h3>
          <button @click="isEditModalOpen = false" class="text-text-secondary hover:text-foreground text-lg leading-none">&times;</button>
        </header>

        <div class="p-4 space-y-3.5 bg-background">
          <!-- 规则名称 -->
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">
              {{ t('styleCustomizer.ruleName', '规则名称') }}
            </label>
            <input
              type="text"
              v-model="ruleForm.name"
              placeholder="例如：Pod 状态"
              class="w-full px-3 py-1.5 text-xs rounded border border-border bg-input text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
          </div>

          <!-- 正则表达式 -->
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">
              {{ t('styleCustomizer.rulePattern', '正则表达式') }}
            </label>
            <input
              type="text"
              v-model="ruleForm.pattern"
              @input="validateRegex(ruleForm.pattern, ruleForm.flags)"
              placeholder="例如：\\b(CrashLoopBackOff|Pending)\\b"
              class="w-full px-3 py-1.5 font-mono text-xs rounded border border-border bg-input text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
            <p v-if="regexError" class="text-[11px] text-red-500 mt-1 flex items-center gap-1">
              <i class="fas fa-circle-exclamation text-[10px]"></i>
              {{ regexError }}
            </p>
          </div>

          <!-- 颜色选取与推荐色盘 -->
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">
              {{ t('styleCustomizer.ruleColor', '高亮颜色') }}
            </label>
            <div class="flex items-center gap-2">
              <input
                type="color"
                v-model="ruleForm.color"
                class="w-7 h-7 rounded border border-border cursor-pointer p-0 bg-input shrink-0"
              />
              <input
                type="text"
                v-model="ruleForm.color"
                class="w-20 px-2 py-1 text-xs font-mono uppercase rounded border border-border bg-input text-foreground outline-none"
              />
              <!-- 快捷颜色色盘 -->
              <div class="flex items-center gap-1 flex-wrap">
                <button
                  v-for="c in PALETTE_COLORS"
                  :key="c"
                  type="button"
                  @click="ruleForm.color = c"
                  class="w-5 h-5 rounded border border-border/80 transition-transform hover:scale-110"
                  :style="{ backgroundColor: c }"
                ></button>
              </div>
            </div>
          </div>

          <!-- 样式开关选项 -->
          <div class="flex items-center gap-5 pt-0.5">
            <label class="flex items-center gap-1.5 cursor-pointer text-xs">
              <input type="checkbox" v-model="ruleForm.bold" class="rounded border-border text-primary focus:ring-primary" />
              <span class="font-bold">加粗 (Bold)</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer text-xs">
              <input type="checkbox" v-model="ruleForm.underline" class="rounded border-border text-primary focus:ring-primary" />
              <span class="underline">下划线 (Underline)</span>
            </label>
          </div>
        </div>

        <footer class="px-4 py-2.5 border-t border-border bg-footer/60 flex justify-end gap-2">
          <button
            @click="isEditModalOpen = false"
            class="px-3 py-1.5 text-xs border border-border rounded bg-background hover:bg-muted text-text-secondary transition-colors"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            @click="handleSaveRule"
            :disabled="!ruleForm.name.trim() || !ruleForm.pattern.trim() || !!regexError"
            class="px-3 py-1.5 text-xs font-semibold rounded bg-button text-button-text hover:bg-button-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ t('common.save', '保存') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>
