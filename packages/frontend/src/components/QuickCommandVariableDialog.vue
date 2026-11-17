<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import {
  cancelQuickCommandVariablePrompt,
  ignoreQuickCommandVariable,
  quickCommandVariablePromptState,
  submitQuickCommandVariables,
} from '../composables/quickCommands/useQuickCommandVariablePrompt';

/**
 * 快捷指令变量补填弹窗（桌面居中卡片 / 移动端底部抽屉）。
 *
 * 触发方式见 useQuickCommandVariablePrompt：指令里存在 `${var}` 且值为空 →
 * 点发送时不直接执行，先让用户把值填上。
 */

const { t } = useI18n();
const { isMobile } = useDeviceDetection();

const visible = computed(() => quickCommandVariablePromptState.value !== null);
const missing = computed(() => quickCommandVariablePromptState.value?.missing ?? []);
const template = computed(() => quickCommandVariablePromptState.value?.template ?? '');
const commandName = computed(() => quickCommandVariablePromptState.value?.commandName ?? '');

/** 输入框的值（本地草稿，确认时才提交） */
const draft = ref<Record<string, string>>({});
const inputRefs = ref<Record<string, HTMLInputElement | null>>({});

const focusFirst = async () => {
  // 移动端不自动聚焦：一起床就弹软键盘会把刚出现的抽屉顶掉，用户还没看清要填什么
  if (isMobile.value) return;
  await nextTick();
  const first = missing.value[0];
  if (!first) return;
  const el = inputRefs.value[first];
  el?.focus();
  if (el) el.select();
};

watch(visible, (open) => {
  if (!open) {
    draft.value = {};
    return;
  }
  // 预填已有值（通常是"定义了变量但值是空串"，也可能是上次填到一半的值）
  const state = quickCommandVariablePromptState.value;
  const next: Record<string, string> = {};
  for (const name of state?.missing ?? []) next[name] = state?.values?.[name] ?? '';
  draft.value = next;
  focusFirst();
});

const allFilled = computed(() => missing.value.every((name) => (draft.value[name] ?? '').trim() !== ''));
const filledCount = computed(() => missing.value.filter((name) => (draft.value[name] ?? '').trim() !== '').length);

const submit = () => {
  if (!allFilled.value) return;
  const payload: Record<string, string> = {};
  for (const name of missing.value) payload[name] = (draft.value[name] ?? '').trim();
  submitQuickCommandVariables(payload);
};

const cancel = () => cancelQuickCommandVariablePrompt();

const markAsNotVariable = (name: string) => {
  void ignoreQuickCommandVariable(name, draft.value);
};

/** 模板里 ${name} 这种写法不方便直接写在模板里，统一由它产出 */
const varToken = (name: string) => '${' + name + '}';

const onKeydown = (event: KeyboardEvent) => {
  if (!visible.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  } else if (event.key === 'Enter' && !event.isComposing) {
    // 单行输入，回车即发送（输入法组词中的回车不会走到这里）
    event.preventDefault();
    submit();
  }
};

// 焦点可能落在弹窗内任意位置（甚至 body），所以监听在 window 上，比绑在遮罩上可靠
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

/** 预览里把变量高亮出来，让用户清楚改的是哪几处（纯展示，v-html 内容来自本地模板，已转义） */
const previewHtml = computed(() => {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escapeHtml(template.value).replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    const isMissing = missing.value.includes(name);
    return `<span class="${isMissing ? 'text-primary font-semibold' : 'text-text-secondary'}">\${${escapeHtml(name)}}</span>`;
  });
});
</script>

<template>
  <teleport to="body">
    <transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="visible"
        class="fixed inset-0 z-[10000] bg-overlay/70 flex"
        :class="isMobile ? 'items-end' : 'items-center justify-center p-4'"
        :style="isMobile ? { height: 'var(--visual-viewport-height, 100%)' } : undefined"
        @mousedown.self="cancel"
      >
        <div
          class="bg-background text-foreground border-border/80 shadow-2xl flex flex-col w-full select-none"
          :class="
            isMobile
              ? 'rounded-t-2xl border-t max-h-[88%] pb-[max(1rem,env(safe-area-inset-bottom))]'
              : 'rounded-2xl border max-w-md max-h-[85vh]'
          "
          style="background-color: var(--app-bg-color);"
          role="dialog"
          aria-modal="true"
          :aria-label="t('quickCommands.variablePrompt.title', '填写指令变量')"
        >
          <!-- 移动端顶部拖拽条（纯视觉） -->
          <div v-if="isMobile" class="flex justify-center pt-2.5 pb-1 flex-shrink-0">
            <span class="w-10 h-1 rounded-full bg-border"></span>
          </div>

          <!-- 头部 -->
          <div class="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
            <div class="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
              <i class="fas fa-code text-sm"></i>
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-base font-semibold text-foreground truncate">
                {{ t('quickCommands.variablePrompt.title', '填写指令变量') }}
              </h3>
              <p class="text-xs text-text-secondary mt-0.5 truncate">
                <template v-if="commandName">{{ commandName }}</template>
                <template v-else>{{ t('quickCommands.variablePrompt.untitled', '未命名指令') }}</template>
                <span class="mx-1">·</span>
                {{
                  t('quickCommands.variablePrompt.description', {
                    count: missing.length,
                  })
                }}
              </p>
            </div>
            <button
              type="button"
              class="w-8 h-8 -mr-1 rounded-lg text-text-secondary hover:bg-muted/60 hover:text-foreground transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
              :aria-label="t('common.cancel', '取消')"
              @click="cancel"
            >
              <i class="fas fa-times text-sm"></i>
            </button>
          </div>

          <!-- 变量输入区（可滚动，变量多时也不会把按钮顶出屏幕） -->
          <div class="px-5 pb-2 overflow-y-auto flex-1 min-h-0 flex flex-col gap-3">
            <div v-for="(name, index) in missing" :key="name" class="flex flex-col gap-1">
              <div class="flex items-center justify-between gap-2">
                <label :for="`qc-var-${index}`" class="text-[11px] font-semibold text-text-secondary tracking-wide">
                  <code class="px-1.5 py-0.5 rounded bg-muted/60 text-primary font-mono">{{ varToken(name) }}</code>
                </label>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded-md text-[11px] text-text-secondary hover:text-foreground hover:bg-muted/60 border border-border/50 transition-colors cursor-pointer shrink-0"
                  :title="t('quickCommands.variablePrompt.notVariableHint', '按字面量原样发送，下次不再提示填写')"
                  @click="markAsNotVariable(name)"
                >
                  {{ t('quickCommands.variablePrompt.notVariable', '这不是变量') }}
                </button>
              </div>
              <input
                :id="`qc-var-${index}`"
                :ref="(el) => (inputRefs[name] = el as HTMLInputElement | null)"
                v-model="draft[name]"
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :placeholder="t('quickCommands.variablePrompt.valuePlaceholder', '输入变量值')"
                class="w-full rounded-xl border border-border/70 bg-background px-3 text-foreground placeholder:text-text-tertiary outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/25"
                :class="isMobile ? 'py-3 text-base' : 'py-2 text-sm'"
              />
            </div>

            <!-- 命令预览 -->
            <div class="flex flex-col gap-1">
              <span class="text-[11px] font-semibold text-text-tertiary">
                {{ t('quickCommands.variablePrompt.previewLabel', '将要执行的指令') }}
              </span>
              <pre
                class="whitespace-pre-wrap break-all rounded-xl border border-border/50 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground max-h-28 overflow-y-auto"
                v-html="previewHtml"
              ></pre>
            </div>
          </div>

          <!-- 底部操作 -->
          <div class="px-5 pt-3 pb-1 flex-shrink-0 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] text-text-tertiary">
                {{
                  t('quickCommands.variablePrompt.filledCounter', {
                    filled: filledCount,
                    total: missing.length,
                  })
                }}
              </span>
              <span v-if="!allFilled" class="text-[11px] text-text-tertiary">
                {{ t('quickCommands.variablePrompt.fillAllHint', '填完所有变量才能发送') }}
              </span>
            </div>
            <div class="flex items-center gap-2" :class="isMobile ? 'flex-col-reverse' : 'justify-end'">
              <button
                type="button"
                class="px-4 py-2 rounded-xl text-xs md:text-sm font-medium border border-border/60 text-text-secondary hover:bg-muted/60 hover:text-foreground transition-colors cursor-pointer"
                :class="isMobile ? 'w-full py-3 text-sm' : ''"
                @click="cancel"
              >
                {{ t('common.cancel', '取消') }}
              </button>
              <button
                type="button"
                :disabled="!allFilled"
                class="px-4 py-2 rounded-xl text-xs md:text-sm font-medium text-white bg-primary hover:bg-primary-hover active:scale-98 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                :class="isMobile ? 'w-full py-3 text-sm' : ''"
                @click="submit"
              >
                <i class="fas fa-paper-plane text-xs"></i>
                <span>{{ t('quickCommands.variablePrompt.send', '发送') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>
