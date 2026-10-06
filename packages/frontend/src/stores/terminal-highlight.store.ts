import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { TerminalHighlightRule, TerminalHighlightConfig } from '../types/terminal-highlight.types';
import { DEFAULT_HIGHLIGHT_RULES } from '../constants/terminal-highlight-presets';
import {
  compileHighlightRules,
  highlightTerminalString,
  type CompiledHighlightRule,
} from '../utils/terminal-highlighter';

export const STORAGE_KEY_TERMINAL_HIGHLIGHT = 'nexus_terminal_highlight_config';

export const useTerminalHighlightStore = defineStore('terminalHighlight', () => {
  // --- 状态初始化 ---
  const enabled = ref(true);
  const rules = ref<TerminalHighlightRule[]>([...DEFAULT_HIGHLIGHT_RULES]);

  // 从本地持久化存储加载
  const loadFromStorage = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_TERMINAL_HIGHLIGHT);
      if (raw) {
        const parsed: Partial<TerminalHighlightConfig> = JSON.parse(raw);
        if (typeof parsed.enabled === 'boolean') {
          enabled.value = parsed.enabled;
        }
        if (Array.isArray(parsed.rules) && parsed.rules.length > 0) {
          rules.value = parsed.rules;
        }
      }
    } catch (e) {
      console.warn('[TerminalHighlightStore] 加载本地配置失败，采用默认预设:', e);
      enabled.value = true;
      rules.value = [...DEFAULT_HIGHLIGHT_RULES];
    }
  };

  // 持久化保存到本地存储
  const saveToStorage = () => {
    try {
      const data: TerminalHighlightConfig = {
        enabled: enabled.value,
        rules: rules.value,
      };
      localStorage.setItem(STORAGE_KEY_TERMINAL_HIGHLIGHT, JSON.stringify(data));
    } catch (e) {
      console.error('[TerminalHighlightStore] 持久化保存失败:', e);
    }
  };

  // 立即加载配置
  loadFromStorage();

  // 预编译缓存的规则列表
  const compiledRules = ref<CompiledHighlightRule[]>([]);

  const refreshCompiledRules = () => {
    if (!enabled.value) {
      compiledRules.value = [];
    } else {
      compiledRules.value = compileHighlightRules(rules.value);
    }
  };

  // 监听状态自动刷新编译缓存并持久化
  watch(
    [enabled, rules],
    () => {
      refreshCompiledRules();
      saveToStorage();
    },
    { deep: true, immediate: true }
  );

  // --- 终端着色流处理入口 ---
  const textDecoder = new TextDecoder('utf-8');

  /**
   * 将终端输出数据应用语法着色
   */
  const highlight = (data: string | Uint8Array): string | Uint8Array => {
    if (!enabled.value || compiledRules.value.length === 0) {
      return data;
    }

    if (typeof data === 'string') {
      return highlightTerminalString(data, compiledRules.value);
    }

    if (data instanceof Uint8Array) {
      try {
        const decoded = textDecoder.decode(data);
        return highlightTerminalString(decoded, compiledRules.value);
      } catch {
        return data;
      }
    }

    return data;
  };

  // --- 规则管理操作 ---
  const toggleEnabled = (val?: boolean) => {
    enabled.value = typeof val === 'boolean' ? val : !enabled.value;
  };

  const toggleRule = (id: string, ruleEnabled?: boolean) => {
    const target = rules.value.find((r) => r.id === id);
    if (target) {
      target.enabled = typeof ruleEnabled === 'boolean' ? ruleEnabled : !target.enabled;
    }
  };

  const addRule = (rule: Omit<TerminalHighlightRule, 'id'>) => {
    const newRule: TerminalHighlightRule = {
      ...rule,
      id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    };
    rules.value.unshift(newRule);
  };

  const updateRule = (id: string, updates: Partial<Omit<TerminalHighlightRule, 'id'>>) => {
    const index = rules.value.findIndex((r) => r.id === id);
    if (index !== -1) {
      rules.value[index] = { ...rules.value[index], ...updates };
    }
  };

  const deleteRule = (id: string) => {
    rules.value = rules.value.filter((r) => r.id !== id);
  };

  const resetToDefault = () => {
    rules.value = JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHT_RULES));
    enabled.value = true;
  };

  const moveRule = (fromIndex: number, toIndex: number) => {
    if (fromIndex < 0 || fromIndex >= rules.value.length || toIndex < 0 || toIndex >= rules.value.length) {
      return;
    }
    const item = rules.value.splice(fromIndex, 1)[0];
    rules.value.splice(toIndex, 0, item);
  };

  return {
    enabled,
    rules,
    compiledRules,
    highlight,
    toggleEnabled,
    toggleRule,
    addRule,
    updateRule,
    deleteRule,
    resetToDefault,
    moveRule,
  };
});
