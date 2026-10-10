// packages/frontend/src/utils/platform.ts
/**
 * 平台环境与功能开关工具模块
 * 用于在保留底层功能完整性的前提下，对桌面端/移动端/Web 端提供轻量级显示与能力控制。
 */

/**
 * 判断当前是否运行在桌面客户端 (Tauri WebView) 环境
 */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;

  const isTauri = Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
  const hasQuery = window.location.search.includes('platform=desktop');
  const hasDataset = document.documentElement.dataset.platform === 'desktop';
  const hasStorage =
    localStorage.getItem('is_desktop_client') === 'true' ||
    sessionStorage.getItem('is_desktop_client') === 'true';

  if (isTauri || hasQuery || hasDataset || hasStorage) {
    try {
      localStorage.setItem('is_desktop_client', 'true');
      sessionStorage.setItem('is_desktop_client', 'true');
      document.documentElement.dataset.platform = 'desktop';
    } catch {}
    return true;
  }

  return false;
}

/**
 * 检查当前运行环境是否支持 RDP / VNC 图形远程桌面功能
 * 说明：
 * RDP 与 VNC 依赖外部 Docker 独立容器 (Guacamole guacd / websockify 等)。
 * 在桌面独立客户端环境下当前不具备此容器，因此暂时关闭对应 UI 入口与连接处理。
 * 未来若针对桌面端适配原生客户端引擎，仅需在此处开启即可无缝恢复。
 */
export function isRemoteDesktopSupported(): boolean {
  return !isDesktopApp();
}
