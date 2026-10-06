import { describe, it, expect } from 'vitest';
import {
  compileHighlightGroups,
  highlightTerminalString,
  highlightPlainTextSegmentWithSpans,
} from './terminal-highlighter';
import { DEFAULT_HIGHLIGHT_GROUPS } from '../constants/terminal-highlight-presets';
import type { TerminalHighlightGroup } from '../types/terminal-highlight.types';

describe('Terminal Highlighter (工业级 Span 仲裁渲染引擎)', () => {
  const matchers = compileHighlightGroups(DEFAULT_HIGHLIGHT_GROUPS);

  describe('1. 真实日志时间戳格式回归测试 (解决用户最初发现的核心痛点)', () => {
    it('应完美匹配逗号分隔毫秒的时间戳: 2026-10-06 19:36:39,084', () => {
      const input = '2026-10-06 19:36:39,084 [INFO] Application started';
      const output = highlightTerminalString(input, matchers);
      expect(output).toContain('\x1b[38;2;148;163;184m2026-10-06 19:36:39,084\x1b[39m');
    });

    it('应匹配点号分隔毫秒的时间戳: 2026-10-06 19:36:39.084', () => {
      const input = '2026-10-06 19:36:39.084 [WARN] Slow query detected';
      const output = highlightTerminalString(input, matchers);
      expect(output).toContain('\x1b[38;2;148;163;184m2026-10-06 19:36:39.084\x1b[39m');
    });

    it('应匹配标准 ISO 8601 带 Z: 2026-10-06T19:36:39.084Z', () => {
      const input = '{"timestamp":"2026-10-06T19:36:39.084Z","level":"error"}';
      const output = highlightTerminalString(input, matchers);
      expect(output).toContain('2026-10-06T19:36:39.084Z');
      expect(output).toContain('\x1b[38;2;148;163;184m');
    });

    it('应匹配 ISO 8601 逗号带 Z: 2026-10-06T19:36:39,084Z', () => {
      const input = '2026-10-06T19:36:39,084Z event received';
      const output = highlightTerminalString(input, matchers);
      expect(output).toContain('\x1b[38;2;148;163;184m2026-10-06T19:36:39,084Z\x1b[39m');
    });

    it('应匹配带冒号时区偏移: 2026-10-06 19:36:39+08:00', () => {
      const input = '2026-10-06 19:36:39+08:00 worker spawned';
      const output = highlightTerminalString(input, matchers);
      expect(output).toContain('\x1b[38;2;148;163;184m2026-10-06 19:36:39+08:00\x1b[39m');
    });

    it('应匹配无冒号时区偏移: 2026-10-06 19:36:39+0800', () => {
      const input = '2026-10-06 19:36:39+0800 worker finished';
      const output = highlightTerminalString(input, matchers);
      expect(output).toContain('\x1b[38;2;148;163;184m2026-10-06 19:36:39+0800\x1b[39m');
    });

    it('应匹配 Syslog 传统格式: Oct  6 19:36:39 server sshd[1234]: Accepted connection', () => {
      const input = 'Oct  6 19:36:39 server sshd[1234]: Accepted connection from 192.168.1.2';
      const output = highlightTerminalString(input, matchers);
      expect(output).toContain('\x1b[38;2;148;163;184mOct  6 19:36:39\x1b[39m');
      // 同时应匹配 IP
      expect(output).toContain('\x1b[38;2;192;132;252m192.168.1.2\x1b[39m');
    });
  });

  describe('2. 关键词边界与全词匹配测试 (防止误伤连字符与派生词)', () => {
    it('全词匹配应当只命中 docker，而不应部分染色 docker-compose 或 mydockerapp', () => {
      const customGroup: TerminalHighlightGroup = {
        id: 'test_docker',
        name: 'Docker',
        isBuiltin: false,
        enabled: true,
        color: '#3b82f6',
        bold: true,
        priority: 2,
        keywords: ['docker'],
        keywordWholeWord: true,
        patterns: [],
      };

      const testMatchers = compileHighlightGroups([customGroup]);

      const line1 = 'using docker to run containers';
      const out1 = highlightTerminalString(line1, testMatchers);
      expect(out1).toContain('\x1b[38;2;59;130;246m\x1b[1mdocker\x1b[22m\x1b[39m');

      // 验证 docker-compose 绝不被撕裂误伤
      const line2 = 'docker-compose up -d';
      const out2 = highlightTerminalString(line2, testMatchers);
      expect(out2).not.toContain('\x1b[38;2;59;130;246m'); // 未匹配完整 docker-compose
      expect(out2).toBe('docker-compose up -d');

      // 验证 mydockerapp 与 dockerized 绝不被部分染色
      const line3 = 'mydockerapp is running dockerized';
      const out3 = highlightTerminalString(line3, testMatchers);
      expect(out3).toBe('mydockerapp is running dockerized');
    });
  });

  describe('3. 原生 ANSI 转义序列保护测试', () => {
    it('应当在包含原生 ANSI 彩色控制符时安全着色纯文本段，原生控制码原样保留', () => {
      // 原始带有绿色 ANSI 序列的文本: \x1b[32m[SYSTEM]\x1b[0m 与后续的纯文本时间戳和 ERROR
      const input = '\x1b[32m[SYSTEM]\x1b[0m 2026-10-06 19:36:39,084 ERROR failed!';
      const output = highlightTerminalString(input, matchers);

      // 原生控制序列必须 100% 完整保留在头部
      expect(output.startsWith('\x1b[32m[SYSTEM]\x1b[0m')).toBe(true);

      // 后续纯文本中的时间戳和 ERROR 必须被 Span 正确着色
      expect(output).toContain('\x1b[38;2;148;163;184m2026-10-06 19:36:39,084\x1b[39m');
      expect(output).toContain('\x1b[38;2;239;68;68m\x1b[1mERROR\x1b[22m\x1b[39m');
    });
  });

  describe('4. 规则冲突与特异性仲裁测试 (Specificity)', () => {
    it('URL 内部包含 IP 时，应当由特异性更高的 URL 整体锁定，不应被 IP 规则撕裂', () => {
      const input = 'Visit https://192.168.1.100:8080/dashboard for details';
      const output = highlightTerminalString(input, matchers);

      // URL 整体着色 (天蓝色 + 下划线)
      expect(output).toContain(
        '\x1b[38;2;56;189;248m\x1b[4mhttps://192.168.1.100:8080/dashboard\x1b[24m\x1b[39m'
      );
      // IP 规则的颜色代码不应侵入 URL 内部
      expect(output).not.toContain('\x1b[38;2;192;132;252m');
    });
  });

  describe('5. 一个分组同时包含内置规则、关键词与正则表达式的复合测试', () => {
    it('同一个分组内的关键词与正则模式应共享相同的样式输出', () => {
      const compositeGroup: TerminalHighlightGroup = {
        id: 'test_composite',
        name: 'Composite Error',
        isBuiltin: false,
        enabled: true,
        color: '#ef4444',
        bold: true,
        priority: 2,
        keywords: ['CRITICAL_FAILURE'],
        patterns: ['\\bexit code \\d+\\b'],
      };

      const compMatchers = compileHighlightGroups([compositeGroup]);
      const input = 'Process CRITICAL_FAILURE with exit code 137';
      const output = highlightTerminalString(input, compMatchers);

      expect(output).toContain('\x1b[38;2;239;68;68m\x1b[1mCRITICAL_FAILURE\x1b[22m\x1b[39m');
      expect(output).toContain('\x1b[38;2;239;68;68m\x1b[1mexit code 137\x1b[22m\x1b[39m');
    });
  });

  describe('6. 综合真实生产日志夹具 (End-to-End Fixtures)', () => {
    it('Docker ps 输出场景: 应准确高亮 Up 状态与 Exited 异常状态，不发生撕裂', () => {
      const dockerLine1 = '9b8a7c6d5e4f nginx:alpine Up 2 hours 0.0.0.0:80->80/tcp web-frontend';
      const out1 = highlightTerminalString(dockerLine1, matchers);
      // 成功状态 Up
      expect(out1).toContain('\x1b[38;2;34;197;94m\x1b[1mUp\x1b[22m\x1b[39m');

      const dockerLine2 = '1a2b3c4d5e6f mysql:8.0 Exited (1) 10 mins ago';
      const out2 = highlightTerminalString(dockerLine2, matchers);
      // 失败状态 Exited
      expect(out2).toContain('\x1b[38;2;239;68;68m\x1b[1mExited\x1b[22m\x1b[39m');
    });

    it('Nginx Access 日志场景: 混合时间戳、IP、URL与状态', () => {
      const nginxLine = '192.168.1.100 - - [2026-10-06 18:30:15,084] "GET https://nexus.example.com/api/v1/health HTTP/1.1" 200 OK';
      const out = highlightTerminalString(nginxLine, matchers);

      // IP 地址
      expect(out).toContain('\x1b[38;2;192;132;252m192.168.1.100\x1b[39m');
      // 逗号毫秒时间戳
      expect(out).toContain('\x1b[38;2;148;163;184m2026-10-06 18:30:15,084\x1b[39m');
      // HTTPS 完整链接
      expect(out).toContain('https://nexus.example.com/api/v1/health');
      // OK 成功状态
      expect(out).toContain('\x1b[38;2;34;197;94m\x1b[1mOK\x1b[22m\x1b[39m');
    });

    it('多规则紧凑排列且相邻时，Span 区间切片应无缝对接，不遗漏字符且不产生乱码', () => {
      const line = '2026-10-06 19:36:39,084 ERROR';
      const out = highlightTerminalString(line, matchers);
      expect(out).toBe(
        '\x1b[38;2;148;163;184m2026-10-06 19:36:39,084\x1b[39m \x1b[38;2;239;68;68m\x1b[1mERROR\x1b[22m\x1b[39m'
      );
    });
  });
});
