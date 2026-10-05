import { ref, computed, onMounted, onBeforeUnmount, type Ref, type ComputedRef } from 'vue';
import type { FileListItem } from '../../types/sftp.types';

export interface UseFileManagerVirtualScrollOptions {
  items: ComputedRef<readonly FileListItem[]>;
  containerRef: Ref<HTMLElement | null>;
  rowSizeMultiplier: Ref<number>;
  hasParentLink?: ComputedRef<boolean>;
  baseRowHeight?: number; // 默认基准行高 35px
  buffer?: number; // 上下缓冲行数，默认 8 行
}

export function useFileManagerVirtualScroll(options: UseFileManagerVirtualScrollOptions) {
  const {
    items,
    containerRef,
    rowSizeMultiplier,
    hasParentLink = computed(() => false),
    baseRowHeight = 35,
    buffer = 8,
  } = options;

  const scrollTop = ref(0);
  const containerHeight = ref(600);

  // 单行实际像素高度（随 rowSizeMultiplier 动态计算）
  const itemHeight = computed(() => Math.max(24, Math.round(baseRowHeight * rowSizeMultiplier.value)));

  const totalCount = computed(() => items.value.length);

  // 可视区域开始和结束索引（针对 items 列表）
  const startIndex = computed(() => {
    const parentOffset = hasParentLink.value ? itemHeight.value : 0;
    const effectiveScrollTop = Math.max(0, scrollTop.value - parentOffset);
    const rawStart = Math.floor(effectiveScrollTop / itemHeight.value) - buffer;
    return Math.max(0, rawStart);
  });

  const endIndex = computed(() => {
    const parentOffset = hasParentLink.value ? itemHeight.value : 0;
    const effectiveScrollTop = Math.max(0, scrollTop.value - parentOffset);
    const visibleCount = Math.ceil(containerHeight.value / itemHeight.value);
    const rawEnd = Math.floor(effectiveScrollTop / itemHeight.value) + visibleCount + buffer;
    return Math.min(totalCount.value, rawEnd);
  });

  // 可见切片数据，携带全局实际索引 index
  const visibleItems = computed(() => {
    const start = startIndex.value;
    const end = endIndex.value;
    const list = items.value;
    const slice: Array<{ item: FileListItem; index: number }> = [];

    for (let i = start; i < end; i++) {
      if (list[i]) {
        slice.push({ item: list[i], index: i });
      }
    }
    return slice;
  });

  // 顶部撑开高度与底部撑开高度
  const topPadding = computed(() => {
    return startIndex.value * itemHeight.value;
  });

  const bottomPadding = computed(() => {
    const remaining = totalCount.value - endIndex.value;
    return Math.max(0, remaining * itemHeight.value);
  });

  // RAF 节流滚动监听
  let rafId: number | null = null;
  const onScroll = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      if (containerRef.value) {
        scrollTop.value = containerRef.value.scrollTop;
      }
      rafId = null;
    });
  };

  // 测量容器尺寸
  let resizeObserver: ResizeObserver | null = null;
  const updateContainerHeight = () => {
    if (containerRef.value) {
      containerHeight.value = containerRef.value.clientHeight || 600;
    }
  };

  onMounted(() => {
    if (containerRef.value) {
      containerRef.value.addEventListener('scroll', onScroll, { passive: true });
      updateContainerHeight();

      resizeObserver = new ResizeObserver(() => {
        updateContainerHeight();
      });
      resizeObserver.observe(containerRef.value);
    }
  });

  onBeforeUnmount(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (containerRef.value) {
      containerRef.value.removeEventListener('scroll', onScroll);
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  });

  /**
   * 滚动到指定项索引（支持键盘上下键定位）
   */
  const scrollToIndex = (index: number) => {
    if (!containerRef.value) return;
    const parentOffset = hasParentLink.value ? itemHeight.value : 0;
    const targetTop = index * itemHeight.value + parentOffset;
    const currentScrollTop = containerRef.value.scrollTop;
    const viewportHeight = containerHeight.value;

    if (targetTop < currentScrollTop) {
      containerRef.value.scrollTop = targetTop;
    } else if (targetTop + itemHeight.value > currentScrollTop + viewportHeight) {
      containerRef.value.scrollTop = targetTop + itemHeight.value - viewportHeight;
    }
  };

  return {
    itemHeight,
    visibleItems,
    topPadding,
    bottomPadding,
    startIndex,
    endIndex,
    scrollToIndex,
  };
}
