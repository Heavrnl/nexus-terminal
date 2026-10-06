/**
 * 跨端/全环境通用安全复制文本到剪贴板
 * 针对局域网 HTTP（非安全上下文）、微信/手机浏览器等限制环境提供完整的降级兼容方案
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. 尝试使用现代 Clipboard API（仅在 HTTPS 或 localhost 安全上下文中可用）
  if (navigator?.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('[Clipboard] navigator.clipboard.writeText 写入失败，尝试降级兼容方案:', err);
    }
  }

  // 2. 传统兼容降级方案：创建不可见的只读 textarea 并通过 document.execCommand 复制
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;

    // 设置固定定位与不可视样式，防止页面跳动或滚动
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    textArea.style.opacity = '0';
    textArea.setAttribute('readonly', ''); // 防止 iOS 唤出虚拟软键盘

    document.body.appendChild(textArea);

    // 选中文本内容
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length); // 兼容移动端 Safari

    const success = document.execCommand('copy');
    document.body.removeChild(textArea);

    return success;
  } catch (fallbackError) {
    console.error('[Clipboard] 降级复制方案执行失败:', fallbackError);
    return false;
  }
}
