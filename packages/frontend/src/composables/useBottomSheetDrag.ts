import { ref, watch, onUnmounted, type Ref } from 'vue';

export interface UseBottomSheetDragOptions {
  /**
   * 关闭抽屉的回调函数
   */
  onClose: () => void;
  /**
   * 下拉触发关闭的最小位移阈值 (px)，默认 70
   */
  threshold?: number;
  /**
   * 快速轻扫速度阈值 (px/ms)，在快速向下滑动时触发关闭，默认 0.25
   */
  velocityThreshold?: number;
  /**
   * 可选外部传入的 sheetRef
   */
  sheetRef?: Ref<HTMLElement | null>;
  /**
   * 可选外部传入的 handleRef
   */
  handleRef?: Ref<HTMLElement | null>;
}

/**
 * 移动端底部抽屉 (Bottom Sheet) 智能多档上下拖拽与高度自适应 Composable
 * 
 * 核心设计：
 * 1. 向上拖动：实时 1:1 跟手拉高抽屉高度至屏幕最顶端 (100% 视口高度)，突破 CSS 限制，松手稳固停靠；
 * 2. 向下拖动：从全屏态平滑缩减至默认半屏态，或从半屏态平滑下拉滑出关闭 (Dismiss)；
 * 3. 告别二次弹出：手势下滑关闭与 Vue Transition 无缝协同，彻底消除“消失后又弹出再消失”的闪烁 Bug；
 * 4. 指针捕获：采用 Pointer Capture API 保证全流程事件不中断、不丢帧；
 * 5. 防误触机制：提供 justDragged 保护，防止拖动松手时误触发子元素或手柄的 click 事件。
 */
export function useBottomSheetDrag(options: UseBottomSheetDragOptions) {
  const {
    onClose,
    threshold = 70,
    velocityThreshold = 0.25,
  } = options;

  const sheetRef = options.sheetRef || ref<HTMLElement | null>(null);
  const handleRef = options.handleRef || ref<HTMLElement | null>(null);

  const isDragging = ref(false);
  const currentSnap = ref<'default' | 'expanded'>('default');

  // 内部测量的参考高度
  let measuredDefaultHeight = 0;
  let measuredMaxHeight = 0;

  let startY = 0;
  let startX = 0;
  let startTime = 0;
  let startHeight = 0;
  let isVerticalDrag = false;
  let hasMoved = false;
  let currentTranslateY = 0;
  let currentHeight = 0;

  // 捕获指针目标，防止事件丢失
  let capturedTarget: HTMLElement | null = null;
  let capturedPointerId: number | null = null;

  // 拖动刚结束的保护期标记（防止 click 误触）
  let justDragged = false;
  let dragCooldownTimer: number | null = null;

  const isJustDragged = () => justDragged;

  // 获取屏幕真实可视高度
  const getScreenHeight = () => {
    return window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 800;
  };

  // 获取当前屏幕可用限制高度（支持拉满到屏幕最顶端）
  const updateReferenceHeights = () => {
    const screenH = getScreenHeight();
    // 允许向上拉伸到屏幕最顶端 (100% 视口高度)
    measuredMaxHeight = Math.round(screenH);

    if (sheetRef.value) {
      const currentRectHeight = sheetRef.value.offsetHeight;
      if (currentRectHeight > 100) {
        if (!measuredDefaultHeight) {
          measuredDefaultHeight = Math.min(currentRectHeight, Math.round(screenH * 0.85));
        }
      }
    }

    if (!measuredDefaultHeight) {
      measuredDefaultHeight = Math.round(screenH * 0.72);
    }
  };

  // 重置内联样式（仅在动画彻底完成卸载后执行）
  const resetStyles = () => {
    if (sheetRef.value) {
      sheetRef.value.style.height = '';
      sheetRef.value.style.maxHeight = '';
      sheetRef.value.style.transform = '';
      sheetRef.value.style.transition = '';
      sheetRef.value.style.opacity = '';
    }
    currentSnap.value = 'default';
    measuredDefaultHeight = 0;
    isDragging.value = false;
  };

  const handlePointerDown = (e: PointerEvent) => {
    // 仅响应鼠标主键或单指触摸
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    // 交互元素（按钮、输入框、链接等）不拦截
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, select, a, [data-no-drag]')) {
      return;
    }

    updateReferenceHeights();

    if (!sheetRef.value) return;

    startY = e.clientY;
    startX = e.clientX;
    startTime = performance.now();
    startHeight = sheetRef.value.offsetHeight || measuredDefaultHeight;
    currentHeight = startHeight;
    currentTranslateY = 0;
    isVerticalDrag = false;
    hasMoved = false;
    isDragging.value = true;

    // 突破 CSS 静态类名（如 max-h-[85vh]）的限制，将内联 maxHeight 设为屏幕最顶端
    sheetRef.value.style.maxHeight = `${measuredMaxHeight}px`;

    // 拖动开始时移除 CSS transition 动画，确保 1:1 跟手
    sheetRef.value.style.transition = 'none';

    // 尝试进行 Pointer Capture 锁定事件
    if (target) {
      try {
        target.setPointerCapture(e.pointerId);
        capturedTarget = target;
        capturedPointerId = e.pointerId;
      } catch {
        capturedTarget = null;
        capturedPointerId = null;
      }
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDragging.value || !sheetRef.value) return;

    const deltaY = e.clientY - startY;
    const deltaX = e.clientX - startX;

    // 垂直方向判断
    if (!isVerticalDrag) {
      if (Math.abs(deltaY) > 4 || Math.abs(deltaX) > 4) {
        if (Math.abs(deltaY) >= Math.abs(deltaX)) {
          isVerticalDrag = true;
        } else {
          // 横向滑动明显，退出拖动交还浏览器
          cleanupDragListeners();
          isDragging.value = false;
          return;
        }
      }
    }

    if (!isVerticalDrag) return;

    hasMoved = true;

    // 阻止浏览器默认页面拖拽与下拉刷新
    if (e.cancelable) {
      e.preventDefault();
    }

    if (deltaY < 0) {
      // ========== 向上拖动 (拉大抽屉至顶部) ==========
      currentTranslateY = 0;
      let newHeight = startHeight - deltaY;

      if (newHeight > measuredMaxHeight) {
        // 允许拉到屏幕顶端，超出顶端给予轻微橡皮筋阻尼
        const overflow = newHeight - measuredMaxHeight;
        newHeight = measuredMaxHeight + overflow * 0.15;
      }

      currentHeight = newHeight;
      sheetRef.value.style.height = `${currentHeight}px`;
      sheetRef.value.style.transform = 'translateY(0px)';
    } else {
      // ========== 向下拖动 (缩小或收起抽屉) ==========
      if (startHeight > measuredDefaultHeight + 20) {
        // 当前处于全屏或拉高态：向下拖动时先缩小面板高度
        const newHeight = startHeight - deltaY;
        if (newHeight >= measuredDefaultHeight) {
          currentHeight = newHeight;
          currentTranslateY = 0;
          sheetRef.value.style.height = `${currentHeight}px`;
          sheetRef.value.style.transform = 'translateY(0px)';
        } else {
          // 低于默认高度后，高度锁定为默认高度，并产生向下位移跟手
          currentHeight = measuredDefaultHeight;
          currentTranslateY = measuredDefaultHeight - newHeight;
          sheetRef.value.style.height = `${currentHeight}px`;
          sheetRef.value.style.transform = `translateY(${currentTranslateY}px)`;
        }
      } else {
        // 当前处于默认高度态：向下拖动直接产生顺滑下沉位移准备收起
        currentTranslateY = deltaY;
        currentHeight = startHeight;
        sheetRef.value.style.height = `${startHeight}px`;
        sheetRef.value.style.transform = `translateY(${currentTranslateY}px)`;
      }
    }
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!isDragging.value) return;
    cleanupDragListeners();
    isDragging.value = false;

    // 释放指针捕获
    if (capturedTarget && capturedPointerId !== null) {
      try {
        capturedTarget.releasePointerCapture(capturedPointerId);
      } catch {}
      capturedTarget = null;
      capturedPointerId = null;
    }

    if (!sheetRef.value) return;

    const deltaY = e.clientY - startY;

    // 若无实质位移，视为单纯点击，不拦截后续 click
    if (!hasMoved || Math.abs(deltaY) < 6) {
      if (sheetRef.value) {
        sheetRef.value.style.transform = 'translateY(0px)';
      }
      return;
    }

    // 激活拖动冷却标记，防止拖动松手触发 click 事件
    justDragged = true;
    if (dragCooldownTimer) clearTimeout(dragCooldownTimer);
    dragCooldownTimer = window.setTimeout(() => {
      justDragged = false;
      dragCooldownTimer = null;
    }, 200);

    const duration = performance.now() - startTime;
    const velocity = duration > 0 ? deltaY / duration : 0;

    // ========== 智能档位裁决 (支持直接顶到屏幕最上端) ==========
    // 1. 向上意图：只要向上滑动超过 25px 或有向上划动速度 -> 坚决吸附至屏幕最顶部展开态！
    if (deltaY <= -25 || velocity < -0.15) {
      snapToHeight(measuredMaxHeight, 'expanded');
    }
    // 2. 向下意图：根据起始状态精准区分
    else if (startHeight > measuredDefaultHeight + 30) {
      // 原本处于全屏/拉高态
      if (deltaY > 200 || velocity > 0.5) {
        // 极大幅度向下划动 -> 顺畅收起关闭
        dismissSheet();
      } else if (deltaY >= 25 || velocity > 0.15) {
        // 正常向下滑动 -> 缩回默认半屏态，稳稳停在半屏，绝不关闭
        snapToHeight(measuredDefaultHeight, 'default');
      } else {
        // 微小位移 -> 恢复全屏态
        snapToHeight(measuredMaxHeight, 'expanded');
      }
    } else {
      // 原本处于默认半屏态
      if (deltaY >= threshold || velocity > velocityThreshold) {
        // 下滑超过阈值或快速下轻扫 -> 顺畅收起关闭
        dismissSheet();
      } else {
        // 未达关闭阈值 -> 稳稳吸附回默认半屏态
        snapToHeight(measuredDefaultHeight, 'default');
      }
    }
  };

  const handlePointerCancel = () => {
    if (!isDragging.value) return;
    cleanupDragListeners();
    isDragging.value = false;

    if (capturedTarget && capturedPointerId !== null) {
      try {
        capturedTarget.releasePointerCapture(capturedPointerId);
      } catch {}
      capturedTarget = null;
      capturedPointerId = null;
    }

    // 异常取消时，吸附到就近合理档位
    if (sheetRef.value) {
      if (currentHeight >= (measuredMaxHeight + measuredDefaultHeight) / 2) {
        snapToHeight(measuredMaxHeight, 'expanded');
      } else {
        snapToHeight(measuredDefaultHeight, 'default');
      }
    }
  };

  // 平滑吸附至目标高度并稳固停留（可直接顶到屏幕最上边缘）
  const snapToHeight = (targetHeight: number, snapState: 'default' | 'expanded' = 'default') => {
    if (!sheetRef.value) return;
    currentSnap.value = snapState;
    sheetRef.value.style.transition = 'height 0.28s cubic-bezier(0.16, 1, 0.3, 1), transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
    sheetRef.value.style.maxHeight = `${measuredMaxHeight}px`;
    sheetRef.value.style.height = `${targetHeight}px`;
    sheetRef.value.style.transform = 'translateY(0px)';

    setTimeout(() => {
      if (sheetRef.value && !isDragging.value) {
        sheetRef.value.style.transition = '';
      }
    }, 300);
  };

  // 快速在默认高度和屏幕顶部全屏展开高度之间切换
  const toggleSnap = () => {
    if (isDragging.value || justDragged) return;
    updateReferenceHeights();
    if (currentSnap.value === 'expanded') {
      snapToHeight(measuredDefaultHeight, 'default');
    } else {
      snapToHeight(measuredMaxHeight, 'expanded');
    }
  };

  // 顺滑滑出屏幕收起关闭（与 Vue Transition 彻底统一，杜绝二次弹出）
  const dismissSheet = () => {
    if (!sheetRef.value) {
      onClose();
      return;
    }
    // 顺滑过渡到底部滑出
    sheetRef.value.style.transition = 'transform 0.22s cubic-bezier(0.25, 1, 0.5, 1)';
    sheetRef.value.style.transform = 'translateY(100%)';

    // 立即通知父组件关闭，让 Vue Transition 同步驱动遮罩淡出，无缝衔接
    onClose();
  };

  const cleanupDragListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerCancel);
  };

  const bindHandle = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', handlePointerDown);
  };

  const unbindHandle = (el: HTMLElement | null) => {
    if (!el) return;
    el.removeEventListener('pointerdown', handlePointerDown);
    cleanupDragListeners();
  };

  watch(handleRef, (newEl, oldEl) => {
    if (oldEl) unbindHandle(oldEl);
    if (newEl) bindHandle(newEl);
  }, { immediate: true });

  onUnmounted(() => {
    if (handleRef.value) {
      unbindHandle(handleRef.value);
    }
    cleanupDragListeners();
    resetStyles();
    if (dragCooldownTimer) {
      clearTimeout(dragCooldownTimer);
    }
  });

  return {
    sheetRef,
    handleRef,
    isDragging,
    currentSnap,
    isJustDragged,
    toggleSnap,
    resetStyles,
    snapToHeight,
    dismissSheet,
  };
}
