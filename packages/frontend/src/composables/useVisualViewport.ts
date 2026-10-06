import { ref, onMounted, onUnmounted, computed } from 'vue';

const viewportHeight = ref<number>(typeof window !== 'undefined' ? window.innerHeight : 0);
const viewportWidth = ref<number>(typeof window !== 'undefined' ? window.innerWidth : 0);
const isKeyboardVisible = ref<boolean>(false);

let isInitialized = false;

/**
 * 移动端视觉视口 (Visual Viewport) 管理 Composable
 * 解决移动端软键盘激活、地址栏伸缩导致的底部空白及页面偏移问题
 */
export function useVisualViewport() {
  const updateViewport = () => {
    if (typeof window === 'undefined') return;

    if (window.visualViewport) {
      const height = window.visualViewport.height;
      const width = window.visualViewport.width;

      viewportHeight.value = height;
      viewportWidth.value = width;

      // 动态将真实可视高度与宽度写入根节点 CSS 变量
      document.documentElement.style.setProperty('--visual-viewport-height', `${Math.round(height)}px`);
      document.documentElement.style.setProperty('--visual-viewport-width', `${Math.round(width)}px`);

      // 判断软键盘是否弹起（可视高度比窗口高度小 150px 以上）
      const windowHeight = window.innerHeight;
      const diff = windowHeight - height;
      const keyboardOpen = diff > 150;
      isKeyboardVisible.value = keyboardOpen;

      if (keyboardOpen) {
        document.documentElement.classList.add('keyboard-open');
      } else {
        document.documentElement.classList.remove('keyboard-open');
      }
    } else {
      // 降级使用 innerHeight
      const height = window.innerHeight;
      viewportHeight.value = height;
      document.documentElement.style.setProperty('--visual-viewport-height', `${height}px`);
    }

    // 核心防御：重置因系统输入法激活而产生的非法 window 滚动，防止页面被推上去露底
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  };

  const handleFocusChange = () => {
    // 键盘弹出或收起以及地址栏动画通常需要 100ms - 400ms
    // 分阶段执行校准，确保过渡动画完成后视口高度精准贴合并复位滚动
    [50, 150, 300, 500].forEach((delay) => {
      setTimeout(updateViewport, delay);
    });
  };

  const handleWindowScroll = () => {
    // 移动端全屏应用模式下，杜绝 window 级别的页面位移
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  };

  const initVisualViewport = () => {
    if (isInitialized || typeof window === 'undefined') return;
    isInitialized = true;

    updateViewport();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewport);
      window.visualViewport.addEventListener('scroll', updateViewport);
    } else {
      window.addEventListener('resize', updateViewport);
    }

    window.addEventListener('scroll', handleWindowScroll, { passive: false });
    window.addEventListener('focusin', handleFocusChange);
    window.addEventListener('focusout', handleFocusChange);
  };

  return {
    viewportHeight: computed(() => viewportHeight.value),
    viewportWidth: computed(() => viewportWidth.value),
    isKeyboardVisible: computed(() => isKeyboardVisible.value),
    initVisualViewport,
    updateViewport
  };
}
