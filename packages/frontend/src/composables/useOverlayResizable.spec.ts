import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverlayResizable } from './useOverlayResizable';

describe('useOverlayResizable (文本编辑器窗口大小与跨设备适配)', () => {
  beforeEach(() => {
    // 模拟标准桌面屏幕分辨率 1920x1080
    vi.stubGlobal('innerWidth', 1920);
    vi.stubGlobal('innerHeight', 1080);
  });

  it('未指定像素值时应按照默认比例计算初始宽高', () => {
    const { popupWidthPx, popupHeightPx } = useOverlayResizable({
      initialWidthRatio: 0.5,
      initialHeightRatio: 0.6,
    });
    expect(popupWidthPx.value).toBe(960);
    expect(popupHeightPx.value).toBe(648);
  });

  it('指定初始像素尺寸时应优先采用后端恢复的尺寸', () => {
    const { popupWidthPx, popupHeightPx } = useOverlayResizable({
      initialWidthPx: 1200,
      initialHeightPx: 800,
    });
    expect(popupWidthPx.value).toBe(1200);
    expect(popupHeightPx.value).toBe(800);
  });

  it('换到小屏设备时尺寸应自动受控于当前屏幕视口安全边界 (防溢出保护)', () => {
    // 模拟换到小屏笔记本设备 1280x720
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 720);

    const { popupWidthPx, popupHeightPx } = useOverlayResizable({
      // 后端保存了在大屏幕上的 1600x900
      initialWidthPx: 1600,
      initialHeightPx: 900,
    });

    // 应该被自动 clamp 到小屏设备 95vw (1280 * 0.95 = 1216) 和 95vh (720 * 0.95 = 684)
    expect(popupWidthPx.value).toBe(1216);
    expect(popupHeightPx.value).toBe(684);
  });

  it('通过 setPopupSize 可以动态更新弹窗尺寸', () => {
    const { popupWidthPx, popupHeightPx, setPopupSize } = useOverlayResizable();
    setPopupSize(1000, 700);
    expect(popupWidthPx.value).toBe(1000);
    expect(popupHeightPx.value).toBe(700);
  });

  it('移动端模式下样式应强制为 100vw 全屏覆盖', () => {
    const { getPopupStyle } = useOverlayResizable();
    const mobileStyle = getPopupStyle(true);
    expect(mobileStyle.width).toBe('100vw');
    expect(mobileStyle.height).toBe('100vh');
  });
});
