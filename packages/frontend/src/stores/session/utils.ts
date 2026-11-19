// packages/frontend/src/stores/session/utils.ts

import { decodeRawContentAsync } from '../../utils/encodingDecoder';

/**
 * 生成唯一的会话 ID。
 * @returns {string} 新的会话 ID。
 */
export function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

/**
 * 根据文件名获取 Monaco Editor 对应的语言标识符。
 * @param {string} filename - 文件名。
 * @returns {string} 语言标识符，默认为 'plaintext'。
 */
export const getLanguageFromFilename = (filename: string): string => {
    const extension = filename.split('.').pop()?.toLowerCase();
    switch (extension) {
        case 'js': return 'javascript';
        case 'ts': return 'typescript';
        case 'json': return 'json';
        case 'html': return 'html';
        case 'css': return 'css';
        case 'scss': return 'scss';
        case 'less': return 'less';
        case 'py': return 'python';
        case 'java': return 'java';
        case 'c': return 'c';
        case 'cpp': return 'cpp';
        case 'cs': return 'csharp';
        case 'go': return 'go';
        case 'php': return 'php';
        case 'rb': return 'ruby';
        case 'rs': return 'rust';
        case 'sql': return 'sql';
        case 'sh': return 'shell';
        case 'yaml': case 'yml': return 'yaml';
        case 'md': return 'markdown';
        case 'xml': return 'xml';
        case 'ini': return 'ini';
        case 'bat': return 'bat';
        case 'dockerfile': return 'dockerfile';
        default: return 'plaintext';
    }
};

/**
 * 使用指定的编码异步解码 Base64 编码的原始文件内容（原生 TextDecoder 优先，冷门编码按需动态加载 iconv-lite）。
 */
export const decodeRawContent = (rawContentBase64: string, encoding: string): Promise<string> => {
    return decodeRawContentAsync(rawContentBase64, encoding);
};