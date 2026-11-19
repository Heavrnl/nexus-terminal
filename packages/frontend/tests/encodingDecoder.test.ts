import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeRawContentAsync } from '../src/utils/encodingDecoder.ts';
import { DEFAULT_HIGHLIGHT_GROUPS } from '../src/constants/terminal-highlight-presets.ts';
import { compileHighlightGroups, highlightTerminalString } from '../src/utils/terminal-highlighter.ts';

test('decodeRawContentAsync：UTF-8 中英文与 Emoji 精准解码，空串安全返回', async () => {
  const b64 = Buffer.from('你好 Nexus Terminal 🚀', 'utf8').toString('base64');
  assert.equal(await decodeRawContentAsync(b64, 'utf-8'), '你好 Nexus Terminal 🚀');
  assert.equal(await decodeRawContentAsync('', 'utf-8'), '');
});

test('decodeRawContentAsync：原生 TextDecoder 支持 UTF-16LE 与未知编码回退 UTF-8', async () => {
  const utf16leB64 = Buffer.from('Hello 世界', 'utf16le').toString('base64');
  assert.equal(await decodeRawContentAsync(utf16leB64, 'utf-16le'), 'Hello 世界');

  const utf8B64 = Buffer.from('fallback-ok', 'utf8').toString('base64');
  assert.equal(await decodeRawContentAsync(utf8B64, 'nonexistent-encoding-xyz'), 'fallback-ok');
});

test('compileHighlightGroups：同分组关键词合批显著减少 RegExp 数量且保持语义一致', () => {
  const matchers = compileHighlightGroups(DEFAULT_HIGHLIGHT_GROUPS);
  // 优化前默认 7 组编译出 34 个独立 RegExp；合批后应大幅收敛至 <= 14 个
  assert.ok(matchers.length <= 14, `期望合批后正则数 <= 14，实际为 ${matchers.length}`);

  const line = '2026-11-19 17:30:00 ERROR failed connecting 192.168.1.10 https://example.com/a';
  const out = highlightTerminalString(line, matchers);
  assert.ok(out.includes('\x1b[38;2;'), '应正常注入 24-bit 语法高亮 SGR');
  // 去掉所有注入的 SGR 后，原文本必须 100% 无损一致
  const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(stripped, line);
});
