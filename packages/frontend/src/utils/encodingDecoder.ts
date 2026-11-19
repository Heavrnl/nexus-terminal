/**
 * 前端文件内容按需编码解码器。
 *
 * 优化动机：
 *   旧实现在顶层静态导入 `@vscode/iconv-lite-umd` 与 `buffer/`，将近 900KB 的全套亚洲字符集码表
 *   直接打进了首屏入口 chunk（index-*.js）并常驻浏览器堆内存。
 *
 * 新策略：
 *   1. 使用原生 `atob` -> `Uint8Array` 完成 Base64 解码，零 polyfill 依赖；
 *   2. 优先使用浏览器原生 WHATWG `TextDecoder`（原生支持 UTF-8/UTF-16/GBK/GB18030/Big5/Shift_JIS/EUC-JP/EUC-KR/Windows-125x 等绝大多数编码）；
 *   3. 仅遇到浏览器原生不支持的极少数冷门编码时，才按需动态 `import('@vscode/iconv-lite-umd')` 兜底。
 */

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

let iconvModulePromise: Promise<typeof import('@vscode/iconv-lite-umd')> | null = null;

async function loadIconvFallback() {
  if (!iconvModulePromise) {
    iconvModulePromise = import('@vscode/iconv-lite-umd');
  }
  const mod = await iconvModulePromise;
  return (mod as any).default ?? mod;
}

/**
 * 使用指定字符编码异步解码 Base64 原始文件内容。
 */
export async function decodeRawContentAsync(rawContentBase64: string, encoding: string): Promise<string> {
  try {
    if (!rawContentBase64 || typeof rawContentBase64 !== 'string') {
      return '';
    }
    const bytes = base64ToUint8Array(rawContentBase64);
    const requested = (encoding || 'utf-8').trim();

    // 1. 优先尝试浏览器原生 TextDecoder（零额外包体积与极速原生 C++ 实现）
    try {
      const nativeDecoder = new TextDecoder(requested);
      return nativeDecoder.decode(bytes);
    } catch {
      // 浏览器原生不支持该编码标识，继续走 iconv-lite 按需动态兜底
    }

    // 2. 按需动态加载 iconv-lite 处理冷门编码（@vscode/iconv-lite-umd 直接接受 Uint8Array，无需 buffer polyfill）
    const normalizedEncoding = requested.toLowerCase().replace(/[^a-z0-9]/g, '');
    try {
      const iconv = await loadIconvFallback();
      if (iconv.encodingExists(normalizedEncoding)) {
        return iconv.decode(bytes as any, normalizedEncoding);
      }
    } catch (fallbackErr) {
      console.warn(`[encodingDecoder] 动态加载 iconv-lite 失败，回退 UTF-8:`, fallbackErr);
    }

    // 3. 仍不支持时安全回退 UTF-8
    console.warn(`[encodingDecoder] Unsupported encoding "${encoding}" requested. Falling back to UTF-8.`);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (error: any) {
    console.error(`[encodingDecoder] Error decoding content with encoding "${encoding}":`, error);
    return `// Error decoding content: ${error?.message || error}`;
  }
}
