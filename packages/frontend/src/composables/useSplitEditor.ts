import { ref, computed, type Ref } from 'vue';
import type { FileTab } from '../stores/fileEditor.store';

export type SplitDirection = 'horizontal' | 'vertical';
export type PaneId = 'primary' | 'secondary';

export interface UseSplitEditorOptions {
  storagePrefix?: string;
  defaultDirection?: SplitDirection;
}

/**
 * 分屏编辑器状态管理与交互组合式函数 (VSCode Split Editor 规范)
 */
export function useSplitEditor(
  tabsRef: Ref<FileTab[]>,
  options: UseSplitEditorOptions = {}
) {
  const { storagePrefix = 'nexus_editor', defaultDirection = 'horizontal' } = options;

  const DIRECTION_KEY = `${storagePrefix}_split_direction`;
  const RATIO_KEY = `${storagePrefix}_split_ratio`;

  // 分屏是否激活
  const isSplitActive = ref<boolean>(false);

  // 分屏方向：horizontal (左右水平分屏) | vertical (上下垂直分屏)
  const savedDirection = localStorage.getItem(DIRECTION_KEY) as SplitDirection | null;
  const splitDirection = ref<SplitDirection>(savedDirection === 'vertical' ? 'vertical' : defaultDirection);

  // 分屏比例 (0.15 ~ 0.85，默认 0.5)
  const savedRatio = parseFloat(localStorage.getItem(RATIO_KEY) || '0.5');
  const splitRatio = ref<number>(!isNaN(savedRatio) && savedRatio >= 0.15 && savedRatio <= 0.85 ? savedRatio : 0.5);

  // 主窗格与次级窗格各自激活的标签页 ID
  const primaryActiveTabId = ref<string | null>(null);
  const secondaryActiveTabId = ref<string | null>(null);

  // 当前拥有焦点的活动窗格
  const activePaneId = ref<PaneId>('primary');

  // 是否正在拖拽调整分屏大小
  const isResizing = ref<boolean>(false);

  // 开启分屏 (默认向右拆分，或指定方向)
  const openSplit = (direction: SplitDirection = 'horizontal', targetTabId?: string | null) => {
    splitDirection.value = direction;
    localStorage.setItem(DIRECTION_KEY, direction);

    // 默认次级窗格激活当前主窗格的 Tab 或指定 Tab
    const tabToActivate = targetTabId || primaryActiveTabId.value || (tabsRef.value[0]?.id ?? null);
    secondaryActiveTabId.value = tabToActivate;
    isSplitActive.value = true;
    activePaneId.value = 'secondary';
  };

  // 关闭分屏 (默认关闭次级窗格，如果关闭主窗格则将次级窗格内容并入主窗格)
  const closeSplit = (paneToClose: PaneId = 'secondary') => {
    if (paneToClose === 'primary' && secondaryActiveTabId.value) {
      primaryActiveTabId.value = secondaryActiveTabId.value;
    }
    isSplitActive.value = false;
    activePaneId.value = 'primary';
  };

  // 切换分屏拆分方向 (水平左右 ↔ 垂直上下)
  const toggleSplitDirection = () => {
    splitDirection.value = splitDirection.value === 'horizontal' ? 'vertical' : 'horizontal';
    localStorage.setItem(DIRECTION_KEY, splitDirection.value);
  };

  // 重置分割比例为 50% 对等分屏
  const resetSplitRatio = () => {
    splitRatio.value = 0.5;
    localStorage.setItem(RATIO_KEY, '0.5');
  };

  // 设置指定比例
  const setSplitRatio = (ratio: number) => {
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    splitRatio.value = Number(clamped.toFixed(4));
    localStorage.setItem(RATIO_KEY, String(splitRatio.value));
  };

  // 拖拽调整比例逻辑
  const startSplitResize = (e: MouseEvent, container: HTMLElement) => {
    if (!isSplitActive.value || !container) return;
    isResizing.value = true;

    // 防止文字选区与 iframe 抢事件
    document.body.style.userSelect = 'none';
    document.body.style.cursor = splitDirection.value === 'horizontal' ? 'col-resize' : 'row-resize';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      let ratio = 0.5;

      if (splitDirection.value === 'horizontal') {
        const mouseX = moveEvent.clientX - rect.left;
        ratio = mouseX / rect.width;
      } else {
        const mouseY = moveEvent.clientY - rect.top;
        ratio = mouseY / rect.height;
      }

      setSplitRatio(ratio);
    };

    const onMouseUp = () => {
      isResizing.value = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 处理标签关闭事件，维护两窗格激活状态及分屏自动收起
  const syncTabsAfterClose = (closedTabId: string) => {
    const remainingTabs = tabsRef.value.filter(t => t.id !== closedTabId);

    // 如果全部标签都已关闭，收起分屏
    if (remainingTabs.length === 0) {
      primaryActiveTabId.value = null;
      secondaryActiveTabId.value = null;
      isSplitActive.value = false;
      return;
    }

    // 主窗格修正
    if (primaryActiveTabId.value === closedTabId) {
      primaryActiveTabId.value = remainingTabs[0]?.id ?? null;
    }

    // 次级窗格修正
    if (secondaryActiveTabId.value === closedTabId) {
      secondaryActiveTabId.value = remainingTabs[0]?.id ?? null;
    }
  };

  // 窗格样式计算
  const primaryPaneStyle = computed(() => {
    if (!isSplitActive.value) {
      return { flex: '1 1 100%', width: '100%', height: '100%' };
    }
    const percent = `${(splitRatio.value * 100).toFixed(2)}%`;
    if (splitDirection.value === 'horizontal') {
      return { width: percent, height: '100%', flex: `0 0 ${percent}` };
    } else {
      return { height: percent, width: '100%', flex: `0 0 ${percent}` };
    }
  });

  const secondaryPaneStyle = computed(() => {
    if (!isSplitActive.value) {
      return { display: 'none' };
    }
    const percent = `${((1 - splitRatio.value) * 100).toFixed(2)}%`;
    if (splitDirection.value === 'horizontal') {
      return { width: percent, height: '100%', flex: `0 0 ${percent}` };
    } else {
      return { height: percent, width: '100%', flex: `0 0 ${percent}` };
    }
  });

  return {
    isSplitActive,
    splitDirection,
    splitRatio,
    primaryActiveTabId,
    secondaryActiveTabId,
    activePaneId,
    isResizing,
    openSplit,
    closeSplit,
    toggleSplitDirection,
    resetSplitRatio,
    setSplitRatio,
    startSplitResize,
    syncTabsAfterClose,
    primaryPaneStyle,
    secondaryPaneStyle,
  };
}
