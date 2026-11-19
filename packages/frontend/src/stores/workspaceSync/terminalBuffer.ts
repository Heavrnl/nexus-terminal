/**
 * 终端 buffer 的文本处理（从 workspaceSync.store 抽出，纯函数可单测）。
 */

/** 去掉 ANSI 转义序列（CSI 序列，够用即可） */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

/**
 * 清理快照终端文本末尾悬空的 Shell 提示符行。
 *
 * 场景：新建 SSH 连接时把旧快照的屏幕内容回放进新终端。
 * 旧内容的最后一行往往是 `root@host:~# `（用户还没来得及敲命令就刷新了），
 * 回放后再叠加新 shell 的登录提示符，就会出现两行提示符。
 *
 * 只裁剪**最后一行**且必须形如 `... #` / `$` / `%` / `>`：
 * 中间行的提示符是真实历史，不能动。
 */
export function cleanTrailingPromptForReconnect(text: string): string {
  if (!text) return '';
  const normalized = text.replace(/\r?\n/g, '\r\n');
  const lines = normalized.split('\r\n');
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    if (looksLikePromptLine(lastLine)) {
      lines.pop(); // 裁掉末尾未执行命令的旧提示符，留给新连接的远程 Shell 真实输出
      return lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '');
    }
  }
  return normalized;
}

/**
 * 判断一行是否是悬空的 Shell 提示符（给需要逐行判断的调用方用）。
 *
 * 相比粗糙的 `/[#$%>]\s*$/`，这里排除明显不是提示符的内容：
 *  - HTML/XML 闭合标签（如 `</div>`、`/>`）
 *  - 单独的 `#`（Markdown 标题或注释）
 *  - 超过 120 字符的长日志行尾偶然出现的 `#`/`$`/`>`
 */
export function looksLikePromptLine(line: string): boolean {
  const plain = stripAnsi(line).trimEnd();
  if (!plain) return false;
  if (!/[#$%>]$/.test(plain)) return false;
  // 排除 HTML/XML 标签闭合与注释/Markdown 单独 #
  if (plain === '#' || /<\/?[a-zA-Z][^>]*>$/.test(plain) || /\/>$/.test(plain)) {
    return false;
  }
  if (plain.length > 120) return false;
  return true;
}
