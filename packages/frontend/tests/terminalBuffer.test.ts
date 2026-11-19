import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanTrailingPromptForReconnect,
  looksLikePromptLine,
} from '../src/stores/workspaceSync/terminalBuffer.ts';

test('cleanTrailingPromptForReconnect：裁掉末尾悬空的 root 提示符', () => {
  // 回放旧屏幕 + 新 shell 登录提示符，会叠出两行提示符
  const input = 'root@h:~# ls\r\nfile.txt\r\nroot@h:~# ';
  assert.equal(cleanTrailingPromptForReconnect(input), 'root@h:~# ls\r\nfile.txt\r\n');
});

test('cleanTrailingPromptForReconnect：末尾是命令输出时原样保留', () => {
  const input = 'root@h:~# ls\r\nfile.txt\r\n';
  assert.equal(cleanTrailingPromptForReconnect(input), 'root@h:~# ls\r\nfile.txt\r\n');
});

test('cleanTrailingPromptForReconnect：只有一行提示符时返回空串', () => {
  assert.equal(cleanTrailingPromptForReconnect('root@h:~#'), '');
  assert.equal(cleanTrailingPromptForReconnect('root@h:~# '), '');
});

test('cleanTrailingPromptForReconnect：带 ANSI 颜色的提示符也能识别', () => {
  const input = 'cmd output\r\n\x1b[32mroot@h\x1b[0m:\x1b[34m~\x1b[0m# ';
  assert.equal(cleanTrailingPromptForReconnect(input), 'cmd output\r\n');
});

test('cleanTrailingPromptForReconnect：$ / % / > 结尾同样视为提示符', () => {
  assert.equal(cleanTrailingPromptForReconnect('out\r\nuser@h:~$ '), 'out\r\n');
  assert.equal(cleanTrailingPromptForReconnect('out\r\nzsh% '), 'out\r\n');
  assert.equal(cleanTrailingPromptForReconnect('out\r\n> '), 'out\r\n');
});

test('cleanTrailingPromptForReconnect：中间行的提示符不能被裁掉', () => {
  const input = 'root@h:~# echo hi\r\nhi\r\nroot@h:~# ';
  assert.equal(cleanTrailingPromptForReconnect(input), 'root@h:~# echo hi\r\nhi\r\n');
});

test('cleanTrailingPromptForReconnect：LF 与 CRLF 混合时统一成 CRLF', () => {
  assert.equal(cleanTrailingPromptForReconnect('a\nb\nc'), 'a\r\nb\r\nc');
  assert.equal(cleanTrailingPromptForReconnect('a\r\nb'), 'a\r\nb');
});

test('cleanTrailingPromptForReconnect：空输入返回空串', () => {
  assert.equal(cleanTrailingPromptForReconnect(''), '');
});

test('looksLikePromptLine：识别常见提示符，普通输出与 HTML/Markdown 尾符不误判', () => {
  assert.equal(looksLikePromptLine('root@localhost:~# '), true);
  assert.equal(looksLikePromptLine('user@host:~$'), true);
  assert.equal(looksLikePromptLine('total 12'), false);
  assert.equal(looksLikePromptLine(''), false);
  assert.equal(looksLikePromptLine('</div>'), false);
  assert.equal(looksLikePromptLine('#'), false);
  assert.equal(looksLikePromptLine(`${'a'.repeat(130)}#`), false);
});
