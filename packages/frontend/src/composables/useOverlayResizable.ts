import { ref, computed, onBeforeUnmount, getCurrentInstance } from 'vue';

export interface UseOverlayResizableOptions {
  initialWidthRatio?: number; // 默认 0.75
  initialHeightRatio?: number; // 默认 0.85
  initialWidthPx?: number; // 外部指定的初始像素宽度 (如从后端读取)
  initialHeightPx?: number; // 外部指定的初始像素高度 (如从后端读取)
  minWidth?: number; // 默认 400
  minHeight?: number; // 默认 300
  isMobile?: boolean;
  onClose?: () => void;
  onResizeEnd?: (width: number, height: number) => void;
}

const getViewportWidth = (): number => {
  if (typeof window !== 'undefined' && typeof window.innerWidth === 'number') {
    return window.innerWidth;
  }
  if (typeof globalThis !== 'undefined' && typeof (globalThis as any).innerWidth === 'number') {
    return (globalThis as any).innerWidth;
  }
  return 1920;
};

const getViewportHeight = (): number => {
  if (typeof window !== 'undefined' && typeof window.innerHeight === 'number') {
    return window.innerHeight;
  }
  if (typeof globalThis !== 'undefined' && typeof (globalThis as any).innerHeight === 'number') {
    return (globalThis as any).innerHeight;
  }
  return 1080;
};

export function useOverlayResizable(options: UseOverlayResizableOptions = {}) {
  const {
    initialWidthRatio = 0.75,
    initialHeightRatio = 0.85,
    initialWidthPx,
    initialHeightPx,
    minWidth = 400,
    minHeight = 300,
    onClose,
    onResizeEnd,
  } = options;

  const clampWidth = (val: number) => {
    const maxW = getViewportWidth() * 0.95;
    return Math.min(Math.max(minWidth, val), maxW);
  };

  const clampHeight = (val: number) => {
    const maxH = getViewportHeight() * 0.95;
    return Math.min(Math.max(minHeight, val), maxH);
  };

  const defaultWidth = initialWidthPx && !isNaN(initialWidthPx)
    ? clampWidth(initialWidthPx)
    : clampWidth(getViewportWidth() * initialWidthRatio);

  const defaultHeight = initialHeightPx && !isNaN(initialHeightPx)
    ? clampHeight(initialHeightPx)
    : clampHeight(getViewportHeight() * initialHeightRatio);

  const popupWidthPx = ref(defaultWidth);
  const popupHeightPx = ref(defaultHeight);

  const setPopupSize = (width: number, height: number) => {
    popupWidthPx.value = clampWidth(width);
    popupHeightPx.value = clampHeight(height);
  };
  const isResizing = ref(false);
  const justFinishedResizing = ref(false);
  let resizeCooldownTimer: number | null = null;
  const isBackdropMouseDown = ref(false);
  const startX = ref(0);
  const startY = ref(0);
  const startWidthPx = ref(0);
  const startHeightPx = ref(0);

  const getPopupStyle = (isMobile: boolean = false) => {
    if (isMobile) {
      return {
        width: '100vw',
        height: '100vh',
        maxWidth: '100%',
        maxHeight: '100%',
        borderRadius: '0',
        transform: 'none',
        top: '0',
        left: '0',
      };
    }
    return {
      width: `${popupWidthPx.value}px`,
      height: `${popupHeightPx.value}px`,
      maxWidth: '95vw',
      maxHeight: '95vh',
    };
  };

  const handleResize = (event: MouseEvent) => {
    if (!isResizing.value) return;
    const diffX = event.clientX - startX.value;
    const diffY = event.clientY - startY.value;
    popupWidthPx.value = clampWidth(startWidthPx.value + diffX);
    popupHeightPx.value = clampHeight(startHeightPx.value + diffY);
  };

  const stopResize = () => {
    if (isResizing.value) {
      isResizing.value = false;
      isBackdropMouseDown.value = false;
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', stopResize);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      justFinishedResizing.value = true;
      if (onResizeEnd) {
        onResizeEnd(Math.round(popupWidthPx.value), Math.round(popupHeightPx.value));
      }
      if (resizeCooldownTimer) clearTimeout(resizeCooldownTimer);
      resizeCooldownTimer = window.setTimeout(() => {
        justFinishedResizing.value = false;
        resizeCooldownTimer = null;
      }, 250);
    }
  };

  const startResize = (event: MouseEvent) => {
    isResizing.value = true;
    justFinishedResizing.value = false;
    isBackdropMouseDown.value = false;
    if (resizeCooldownTimer) {
      clearTimeout(resizeCooldownTimer);
      resizeCooldownTimer = null;
    }
    startX.value = event.clientX;
    startY.value = event.clientY;
    startWidthPx.value = popupWidthPx.value;
    startHeightPx.value = popupHeightPx.value;
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
  };

  const handleBackdropMouseDown = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      isBackdropMouseDown.value = true;
    } else {
      isBackdropMouseDown.value = false;
    }
  };

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target !== event.currentTarget) {
      isBackdropMouseDown.value = false;
      return;
    }
    if (!isBackdropMouseDown.value) {
      return;
    }
    if (isResizing.value || justFinishedResizing.value) {
      isBackdropMouseDown.value = false;
      return;
    }

    isBackdropMouseDown.value = false;
    if (onClose) {
      onClose();
    }
  };

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      stopResize();
      if (resizeCooldownTimer) {
        clearTimeout(resizeCooldownTimer);
        resizeCooldownTimer = null;
      }
    });
  }

  return {
    popupWidthPx,
    popupHeightPx,
    isResizing,
    getPopupStyle,
    startResize,
    stopResize,
    handleBackdropMouseDown,
    handleBackdropClick,
    setPopupSize,
  };
}
