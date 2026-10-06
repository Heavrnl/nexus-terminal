import { defineStore } from 'pinia';
import { ref, watch, computed } from 'vue';
import type { TerminalHighlightGroup, TerminalHighlightConfig } from '../types/terminal-highlight.types';
import { DEFAULT_HIGHLIGHT_GROUPS } from '../constants/terminal-highlight-presets';
import {
  compileHighlightGroups,
  highlightTerminalString,
  type CompiledMatcher,
} from '../utils/terminal-highlighter';

export const STORAGE_KEY_TERMINAL_HIGHLIGHT = 'nexus_terminal_highlight_config_v2';
const LEGACY_STORAGE_KEY = 'nexus_terminal_highlight_config';

export const useTerminalHighlightStore = defineStore('terminalHighlight', () => {
  // --- 状态初始化 ---
  const enabled = ref(true);
  const groups = ref<TerminalHighlightGroup[]>([...DEFAULT_HIGHLIGHT_GROUPS]);

  // 向后兼容 rules 别名
  const rules = computed({
    get: () => groups.value,
    set: (val: TerminalHighlightGroup[]) => {
      groups.value = val;
    },
  });

  // 从本地持久化存储加载 (支持旧版配置自动平滑迁移)
  const loadFromStorage = () => {
    try {
      // 1. 优先读取 v2 新语义分组配置
      const rawV2 = localStorage.getItem(STORAGE_KEY_TERMINAL_HIGHLIGHT);
      if (rawV2) {
        const parsed: Partial<TerminalHighlightConfig> = JSON.parse(rawV2);
        if (typeof parsed.enabled === 'boolean') {
          enabled.value = parsed.enabled;
        }
        if (Array.isArray(parsed.groups) && parsed.groups.length > 0) {
          groups.value = parsed.groups;
          return;
        }
      }

      // 2. 若无 v2 配置，则检测是否有旧版 v1 单正则规则并进行无缝平滑迁移
      const rawV1 = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (rawV1) {
        const parsedV1 = JSON.parse(rawV1);
        if (typeof parsedV1.enabled === 'boolean') {
          enabled.value = parsedV1.enabled;
        }

        const migratedGroups: TerminalHighlightGroup[] = JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHT_GROUPS));

        // 提取用户以前自己添加的非内置规则，自动包装为自定义分组卡片
        if (Array.isArray(parsedV1.rules)) {
          const userCustomRules = parsedV1.rules.filter((r: any) => !r.isBuiltin && r.pattern);
          for (const customRule of userCustomRules) {
            migratedGroups.push({
              id: customRule.id || `custom_group_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              name: customRule.name || '自定义规则',
              isBuiltin: false,
              enabled: customRule.enabled ?? true,
              color: customRule.color || '#3b82f6',
              bold: !!customRule.bold,
              underline: !!customRule.underline,
              priority: 2,
              matchers: [
                {
                  id: `m_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                  type: 'regex',
                  pattern: customRule.pattern,
                  flags: customRule.flags || 'g',
                },
              ],
              keywords: [],
              patterns: [customRule.pattern],
              flags: customRule.flags || 'g',
            });
          }
        }

        groups.value = migratedGroups;
        saveToStorage();
        return;
      }
    } catch (e) {
      console.warn('[TerminalHighlightStore] 加载本地配置失败，重置为默认预设:', e);
      enabled.value = true;
      groups.value = JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHT_GROUPS));
    }
  };

  // 持久化保存到本地存储
  const saveToStorage = () => {
    try {
      const data: TerminalHighlightConfig = {
        enabled: enabled.value,
        groups: groups.value,
      };
      localStorage.setItem(STORAGE_KEY_TERMINAL_HIGHLIGHT, JSON.stringify(data));
    } catch (e) {
      console.error('[TerminalHighlightStore] 持久化保存失败:', e);
    }
  };

  // 立即加载配置
  loadFromStorage();

  // 预编译缓存的 Matcher 集合
  const compiledMatchers = ref<CompiledMatcher[]>([]);

  const refreshCompiledRules = () => {
    if (!enabled.value) {
      compiledMatchers.value = [];
    } else {
      compiledMatchers.value = compileHighlightGroups(groups.value);
    }
  };

  // 监听状态变更自动刷新预编译 Matcher 并持久化
  watch(
    [enabled, groups],
    () => {
      refreshCompiledRules();
      saveToStorage();
    },
    { deep: true, immediate: true }
  );

  // --- 终端着色流处理入口 ---
  const textDecoder = new TextDecoder('utf-8');

  /**
   * 将终端输出数据应用语法着色 (Span 冲突仲裁)
   */
  const highlight = (data: string | Uint8Array): string | Uint8Array => {
    if (!enabled.value || compiledMatchers.value.length === 0) {
      return data;
    }

    if (typeof data === 'string') {
      return highlightTerminalString(data, compiledMatchers.value);
    }

    if (data instanceof Uint8Array) {
      try {
        const decoded = textDecoder.decode(data);
        return highlightTerminalString(decoded, compiledMatchers.value);
      } catch {
        return data;
      }
    }

    return data;
  };

  // --- 分组管理操作 ---
  const toggleEnabled = (val?: boolean) => {
    enabled.value = typeof val === 'boolean' ? val : !enabled.value;
  };

  const toggleGroup = (id: string, groupEnabled?: boolean) => {
    const target = groups.value.find((g) => g.id === id);
    if (target) {
      target.enabled = typeof groupEnabled === 'boolean' ? groupEnabled : !target.enabled;
    }
  };

  const addGroup = (group: Omit<TerminalHighlightGroup, 'id' | 'isBuiltin'>) => {
    const newGroup: TerminalHighlightGroup = {
      ...group,
      id: `group_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      isBuiltin: false,
    };
    groups.value.push(newGroup);
  };

  const updateGroup = (id: string, updates: Partial<Omit<TerminalHighlightGroup, 'id' | 'isBuiltin'>>) => {
    const index = groups.value.findIndex((g) => g.id === id);
    if (index !== -1) {
      groups.value[index] = { ...groups.value[index], ...updates };
    }
  };

  const deleteGroup = (id: string) => {
    // 内置分组保护，只允许删除用户自建分组
    groups.value = groups.value.filter((g) => g.id !== id || g.isBuiltin);
  };

  const resetToDefault = () => {
    groups.value = JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHT_GROUPS));
    enabled.value = true;
  };

  const moveGroup = (fromIndex: number, toIndex: number) => {
    if (fromIndex < 0 || fromIndex >= groups.value.length || toIndex < 0 || toIndex >= groups.value.length) {
      return;
    }
    const item = groups.value.splice(fromIndex, 1)[0];
    groups.value.splice(toIndex, 0, item);
  };

  return {
    enabled,
    groups,
    rules, // 兼容导出
    compiledRules: compiledMatchers, // 兼容导出
    highlight,
    toggleEnabled,
    toggleGroup,
    toggleRule: toggleGroup, // 兼容别名
    addGroup,
    addRule: addGroup as any, // 兼容别名
    updateGroup,
    updateRule: updateGroup as any, // 兼容别名
    deleteGroup,
    deleteRule: deleteGroup, // 兼容别名
    resetToDefault,
    moveGroup,
    moveRule: moveGroup, // 兼容别名
  };
});
