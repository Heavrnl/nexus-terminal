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
CONTAINER ID   IMAGE          COMMAND                  CREATED         STATUS                    PORTS                  NAMES
9b8a7c6d5e4f   nginx:alpine   "/docker-entrypoint.…"   2 hours ago     Up 2 hours                0.0.0.0:80->80/tcp     web-frontend
1a2b3c4d5e6f   mysql:8.0      "docker-entrypoint.s…"   5 hours ago     Exited (1) 10 mins ago    0.0.0.0:3306->3306/tcp db-production
3c4d5e6f7a8b   redis:7-alpine "docker-entrypoint.s…"   1 day ago       Up 1 day (healthy)        0.0.0.0:6379->6379/tcp cache-redis
d8e9f0123456   backend:latest "node dist/index.js"     3 days ago      dead                      8080/tcp               api-service`,

  log: `$ tail -n 4 /var/log/nginx/access.log
2026-10-06 18:30:15 [INFO] 192.168.1.100 GET https://nexus.example.com/api/v1/health 200 OK
2026-10-06 18:30:16 [WARN] Slow database query detected from 10.0.0.8:5432, duration: 1820ms
2026-10-06 18:30:17 [ERROR] Connection refused to 172.16.0.4:6379, retry 3 of 5 failed!
2026-10-06 18:30:18 [FATAL] Critical cluster node disconnected, active state changed to down.`,

  network: `$ ip addr show eth0 && netstat -tlpn
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP group default
    inet 192.168.1.188/24 brd 192.168.1.255 scope global eth0
    valid_lft forever preferred_lft forever
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      892/sshd: /usr/sbin
tcp        0      0 127.0.0.1:3000          0.0.0.0:*               LISTEN      14205/node /opt/app
tcp6       0      0 :::80                   :::*                    LISTEN      1024/nginx: master`,
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
  description: '',
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
    description: '',
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
    description: rule.description || '',
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
      description: ruleForm.value.description.trim(),
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
      description: ruleForm.value.description.trim(),
    });
  }
  isEditModalOpen.value = false;
};

const handleResetToDefault = () => {
  if (confirm(t('styleCustomizer.confirmResetHighlight', '确定要恢复默认预设高亮规则吗？自定义修改将被重置。'))) {
    highlightStore.resetToDefault();
  }
};
</script>

<template>
  <div class="space-y-6 pb-6">
    <!-- 1. 顶部全局开关与总览卡片 -->
    <div class="bg-card border border-border/70 rounded-xl p-4 sm:p-5 shadow-2xs">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="flex items-start sm:items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-lg shrink-0">
            <i class="fas fa-highlighter"></i>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h3 class="text-base sm:text-lg font-semibold text-foreground">
                {{ t('styleCustomizer.highlightTitle', '终端代码与关键字高亮') }}
              </h3>
              <span class="text-xs px-2 py-0.5 rounded-full font-medium bg-primary/15 text-primary border border-primary/20">
                WindTerm / MobaXterm
              </span>
            </div>
            <p class="text-xs sm:text-sm text-text-secondary mt-1">
              {{ t('styleCustomizer.highlightDesc', '在客户端实时识别日志、Docker 状态、IP 地址、哈希与路径并着色渲染') }}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-3 shrink-0 self-end sm:self-center">
          <button
            @click="handleResetToDefault"
            class="px-3 py-1.5 text-xs sm:text-sm border border-border rounded-lg bg-background hover:bg-muted text-text-secondary hover:text-foreground transition-colors flex items-center gap-1.5"
            :title="t('styleCustomizer.resetHighlightTitle', '恢复经典预设规则')"
          >
            <i class="fas fa-rotate-left text-xs"></i>
            {{ t('styleCustomizer.resetDefault', '恢复预设') }}
          </button>
          <button
            @click="handleOpenAddModal"
            class="px-3 py-1.5 text-xs sm:text-sm border border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary rounded-lg transition-colors font-medium flex items-center gap-1.5"
          >
            <i class="fas fa-plus text-xs"></i>
            {{ t('styleCustomizer.addRule', '添加规则') }}
          </button>
          <ToggleSwitch
            :model-value="highlightStore.enabled"
            @update:model-value="highlightStore.toggleEnabled"
            aria-label="启用终端代码高亮"
          />
        </div>
      </div>
    </div>

    <!-- 2. 实时效果终端预览框 (Live Terminal Preview) -->
    <div class="bg-card border border-border/70 rounded-xl overflow-hidden shadow-2xs">
      <div class="px-4 py-2.5 border-b border-border/70 bg-header/40 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <!-- 终端仿 macOS 圆点 -->
          <div class="flex items-center gap-1.5 mr-2">
            <span class="w-2.5 h-2.5 rounded-full bg-red-500/80 inline-block"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-yellow-500/80 inline-block"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-green-500/80 inline-block"></span>
          </div>
          <span class="text-xs font-semibold text-foreground/80 tracking-wide uppercase">
            {{ t('styleCustomizer.livePreview', '实时渲染预览') }}
          </span>
        </div>

        <!-- 样本切换标签页 -->
        <div class="flex items-center gap-1 bg-background/80 p-0.5 rounded-lg border border-border/60">
          <button
            @click="currentSample = 'docker'"
            :class="['px-2.5 py-1 text-xs rounded-md transition-colors font-medium', currentSample === 'docker' ? 'bg-primary text-white' : 'text-text-secondary hover:text-foreground']"
          >
            Docker
          </button>
          <button
            @click="currentSample = 'log'"
            :class="['px-2.5 py-1 text-xs rounded-md transition-colors font-medium', currentSample === 'log' ? 'bg-primary text-white' : 'text-text-secondary hover:text-foreground']"
          >
            Logs
          </button>
          <button
            @click="currentSample = 'network'"
            :class="['px-2.5 py-1 text-xs rounded-md transition-colors font-medium', currentSample === 'network' ? 'bg-primary text-white' : 'text-text-secondary hover:text-foreground']"
          >
            Network
          </button>
        </div>
      </div>

      <!-- 终端黑底视口 -->
      <div class="bg-[#12141a] p-3 sm:p-4 font-mono text-xs sm:text-[13px] leading-relaxed text-gray-200 overflow-x-auto whitespace-pre selection:bg-primary/40 selection:text-white">
        <div v-html="previewHtml"></div>
      </div>
    </div>

    <!-- 3. 高亮规则列表 -->
    <div class="bg-card border border-border/70 rounded-xl overflow-hidden shadow-2xs">
      <div class="px-4 py-3 border-b border-border/70 bg-header/20 flex items-center justify-between">
        <div class="text-sm font-semibold text-foreground">
          {{ t('styleCustomizer.rulesList', '规则清单与配色') }}
          <span class="text-xs font-normal text-text-secondary ml-1.5">({{ highlightStore.rules.length }})</span>
        </div>
        <span class="text-xs text-text-secondary">
          {{ t('styleCustomizer.orderNotice', '规则自上而下匹配执行') }}
        </span>
      </div>

      <div class="divide-y divide-border/40">
        <div
          v-for="(rule, index) in highlightStore.rules"
          :key="rule.id"
          class="p-3 sm:p-4 hover:bg-muted/20 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-3"
        >
          <!-- 左侧：开关 + 名称 + 正则 + 描述 -->
          <div class="flex items-start gap-3 flex-1 min-w-0">
            <div class="pt-0.5 shrink-0">
              <ToggleSwitch
                size="sm"
                :model-value="rule.enabled"
                @update:model-value="(val) => highlightStore.toggleRule(rule.id, val)"
                :aria-label="`启用规则 ${rule.name}`"
              />
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-medium text-foreground truncate" :class="{ 'opacity-60': !rule.enabled }">
                  {{ rule.name }}
                </span>
                <span v-if="rule.isBuiltin" class="text-[11px] px-1.5 py-0.2 rounded bg-muted text-text-secondary border border-border/50">
                  预设
                </span>
              </div>

              <!-- 正则表达式芯片 -->
              <div class="mt-1 flex items-center gap-2">
                <code class="text-xs px-2 py-0.5 rounded bg-muted/60 text-text-secondary font-mono truncate max-w-[280px] sm:max-w-[420px] border border-border/30">
                  {{ rule.pattern }}
                </code>
              </div>

              <p v-if="rule.description" class="text-xs text-text-secondary mt-1">
                {{ rule.description }}
              </p>
            </div>
          </div>

          <!-- 右侧：样式控制 + 调色盘 + 操作按钮 -->
          <div class="flex items-center gap-2.5 shrink-0 self-end md:self-center">
            <!-- 视觉预览小胶囊 -->
            <div
              class="px-2.5 py-1 rounded text-xs font-mono border border-border/50 bg-[#161922] flex items-center gap-1.5"
              :style="{
                color: rule.color,
                fontWeight: rule.bold ? '700' : '400',
                textDecoration: rule.underline ? 'underline' : 'none',
              }"
            >
              <span class="w-2 h-2 rounded-full inline-block" :style="{ backgroundColor: rule.color }"></span>
              Aa样本
            </div>

            <!-- 原生颜色选择器 -->
            <label class="relative cursor-pointer w-7 h-7 rounded-lg border border-border overflow-hidden shadow-2xs flex items-center justify-center shrink-0" :title="t('styleCustomizer.pickColor', '选择颜色')">
              <input
                type="color"
                v-model="rule.color"
                class="absolute -top-4 -left-4 w-16 h-16 cursor-pointer opacity-0"
              />
              <span class="w-full h-full rounded" :style="{ backgroundColor: rule.color }"></span>
            </label>

            <!-- 加粗开关按钮 -->
            <button
              @click="rule.bold = !rule.bold"
              :class="[
                'w-7 h-7 rounded-lg text-xs font-bold border transition-colors flex items-center justify-center',
                rule.bold ? 'bg-primary text-white border-primary' : 'bg-background text-text-secondary border-border hover:bg-muted'
              ]"
              title="加粗"
            >
              B
            </button>

            <!-- 下划线开关按钮 -->
            <button
              @click="rule.underline = !rule.underline"
              :class="[
                'w-7 h-7 rounded-lg text-xs underline border transition-colors flex items-center justify-center font-serif',
                rule.underline ? 'bg-primary text-white border-primary' : 'bg-background text-text-secondary border-border hover:bg-muted'
              ]"
              title="下划线"
            >
              U
            </button>

            <!-- 排序按钮 (上移/下移) -->
            <div class="flex items-center border border-border rounded-lg overflow-hidden bg-background">
              <button
                @click="highlightStore.moveRule(index, index - 1)"
                :disabled="index === 0"
                class="w-6 h-7 text-xs text-text-secondary hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                title="上移"
              >
                <i class="fas fa-chevron-up text-[10px]"></i>
              </button>
              <button
                @click="highlightStore.moveRule(index, index + 1)"
                :disabled="index === highlightStore.rules.length - 1"
                class="w-6 h-7 text-xs text-text-secondary hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                title="下移"
              >
                <i class="fas fa-chevron-down text-[10px]"></i>
              </button>
            </div>

            <!-- 编辑 -->
            <button
              @click="handleOpenEditModal(rule)"
              class="w-7 h-7 rounded-lg border border-border bg-background hover:bg-muted text-text-secondary hover:text-foreground transition-colors flex items-center justify-center text-xs"
              title="编辑规则"
            >
              <i class="fas fa-pen text-[11px]"></i>
            </button>

            <!-- 删除 -->
            <button
              @click="highlightStore.deleteRule(rule.id)"
              class="w-7 h-7 rounded-lg border border-border bg-background hover:bg-red-500/10 text-text-secondary hover:text-red-500 transition-colors flex items-center justify-center text-xs"
              title="删除规则"
            >
              <i class="fas fa-trash-can text-[11px]"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. 添加/编辑规则 Modal 对话框 -->
    <div
      v-if="isEditModalOpen"
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50 p-4"
      @click.self="isEditModalOpen = false"
    >
      <div class="bg-card text-foreground rounded-xl shadow-xl w-full max-w-lg border border-border overflow-hidden">
        <header class="px-5 py-4 border-b border-border bg-header/40 flex justify-between items-center">
          <h3 class="font-semibold text-base">
            {{ editingRuleId ? t('styleCustomizer.editRule', '编辑高亮规则') : t('styleCustomizer.createRule', '添加自定义高亮规则') }}
          </h3>
          <button @click="isEditModalOpen = false" class="text-text-secondary hover:text-foreground text-lg leading-none">&times;</button>
        </header>

        <div class="p-5 space-y-4">
          <!-- 规则名称 -->
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1">
              {{ t('styleCustomizer.ruleName', '规则名称') }} *
            </label>
            <input
              type="text"
              v-model="ruleForm.name"
              placeholder="例如：Kubernetes 命名空间 / 告警状态"
              class="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
          </div>

          <!-- 正则表达式 -->
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1">
              {{ t('styleCustomizer.rulePattern', '正则表达式 (RegExp Pattern)') }} *
            </label>
            <input
              type="text"
              v-model="ruleForm.pattern"
              @input="validateRegex(ruleForm.pattern, ruleForm.flags)"
              placeholder="例如：\\b(CrashLoopBackOff|Pending)\\b"
              class="w-full px-3 py-2 font-mono text-sm rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
            <p v-if="regexError" class="text-xs text-red-500 mt-1 flex items-center gap-1">
              <i class="fas fa-circle-exclamation text-[11px]"></i>
              {{ regexError }}
            </p>
          </div>

          <!-- 颜色选取与推荐色盘 -->
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5">
              {{ t('styleCustomizer.ruleColor', '高亮前景色') }}
            </label>
            <div class="flex items-center gap-3">
              <input
                type="color"
                v-model="ruleForm.color"
                class="w-9 h-9 rounded-lg border border-border cursor-pointer p-0.5 bg-background shrink-0"
              />
              <input
                type="text"
                v-model="ruleForm.color"
                class="w-24 px-2.5 py-1.5 text-xs font-mono uppercase rounded-lg border border-border bg-background outline-none"
              />
              <!-- 快捷颜色色盘 -->
              <div class="flex items-center gap-1.5 flex-wrap">
                <button
                  v-for="c in PALETTE_COLORS"
                  :key="c"
                  type="button"
                  @click="ruleForm.color = c"
                  class="w-6 h-6 rounded-md border border-border/80 transition-transform hover:scale-110"
                  :style="{ backgroundColor: c }"
                ></button>
              </div>
            </div>
          </div>

          <!-- 样式开关选项 -->
          <div class="flex items-center gap-6 pt-1">
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" v-model="ruleForm.bold" class="rounded border-border text-primary focus:ring-primary" />
              <span class="font-bold">加粗 (Bold)</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" v-model="ruleForm.underline" class="rounded border-border text-primary focus:ring-primary" />
              <span class="underline">下划线 (Underline)</span>
            </label>
          </div>

          <!-- 描述 -->
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1">
              {{ t('styleCustomizer.ruleDesc', '规则描述 (可选)') }}
            </label>
            <input
              type="text"
              v-model="ruleForm.description"
              placeholder="说明此规则的匹配用途"
              class="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
          </div>
        </div>

        <footer class="px-5 py-3 border-t border-border bg-footer/40 flex justify-end gap-2">
          <button
            @click="isEditModalOpen = false"
            class="px-4 py-2 text-sm border border-border rounded-lg bg-background hover:bg-muted text-text-secondary transition-colors"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            @click="handleSaveRule"
            :disabled="!ruleForm.name.trim() || !ruleForm.pattern.trim() || !!regexError"
            class="px-4 py-2 text-sm font-semibold rounded-lg bg-button text-button-text hover:bg-button-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ t('common.save', '保存规则') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>
