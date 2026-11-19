import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSafeSyncOutboundUrl,
  isSafeDesktopRoute,
  isSameOriginUrl,
  maskSecret,
} from '../src/sync/outbound-url.ts';
import { isLocalRequest } from '../src/auth/session-policy.ts';

test('assertSafeSyncOutboundUrl：阻断非法协议与内嵌凭据，放行合法 HTTP/HTTPS 地址（含局域网与代理 Fake-IP 场景）', () => {
  const rejectedUrls = [
    '',
    'not-a-url',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_INFO',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'https://user:pass@example.com',
  ];

  for (const target of rejectedUrls) {
    assert.throws(
      () => assertSafeSyncOutboundUrl(target),
      `应当阻断不合法同步地址: ${target}`
    );
  }

  const allowedUrls = [
    'https://sync.example.com',
    'https://sync.example.com:8443/nexus',
    'http://192.168.1.100:3001',
    'http://100.64.0.5:3001',
    'http://127.0.0.1:3001',
  ];
  for (const target of allowedUrls) {
    const parsed = assertSafeSyncOutboundUrl(target);
    assert.ok(parsed.protocol === 'http:' || parsed.protocol === 'https:');
  }
});

test('isSameOriginUrl：严格比较协议、主机与端口，防止密钥跨源泄露', () => {
  assert.equal(isSameOriginUrl('https://vps.example.com', 'https://vps.example.com/'), true);
  assert.equal(isSameOriginUrl('https://vps.example.com:443/a', 'https://vps.example.com/b'), true);
  assert.equal(isSameOriginUrl('https://vps.example.com', 'http://vps.example.com'), false);
  assert.equal(isSameOriginUrl('https://vps.example.com', 'https://evil.example.com'), false);
  assert.equal(isSameOriginUrl('https://vps.example.com:8443', 'https://vps.example.com:8444'), false);
  assert.equal(isSameOriginUrl('', 'https://vps.example.com'), false);
});

test('maskSecret：正确脱敏且不暴露完整明文', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret('abc'), '****');
  assert.equal(maskSecret('abcd'), '****');
  assert.equal(maskSecret('super-secret-key-9876'), '****9876');
});

test('isSafeDesktopRoute：只放行安全站内相对路径，拦截开放重定向与注入字符', () => {
  assert.equal(isSafeDesktopRoute('/workspace'), true);
  assert.equal(isSafeDesktopRoute('/settings?tab=sync'), true);
  assert.equal(isSafeDesktopRoute('//evil.com/phish'), false);
  assert.equal(isSafeDesktopRoute('https://evil.com'), false);
  assert.equal(isSafeDesktopRoute('javascript:alert(1)'), false);
  assert.equal(isSafeDesktopRoute('/workspace\r\nSet-Cookie: a=b'), false);
  assert.equal(isSafeDesktopRoute('/workspace\\evil'), false);
  assert.equal(isSafeDesktopRoute(''), false);
  assert.equal(isSafeDesktopRoute(123), false);
});

test('isLocalRequest：只认不可伪造的 socket.remoteAddress，忽略伪造的 X-Forwarded-For', () => {
  const spoofedReq = {
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
    socket: { remoteAddress: '203.0.113.42' },
  } as any;
  assert.equal(isLocalRequest(spoofedReq), false);

  const localV4Req = { socket: { remoteAddress: '127.0.0.1' } } as any;
  const localMappedReq = { socket: { remoteAddress: '::ffff:127.0.0.1' } } as any;
  const localV6Req = { socket: { remoteAddress: '::1' } } as any;
  assert.equal(isLocalRequest(localV4Req), true);
  assert.equal(isLocalRequest(localMappedReq), true);
  assert.equal(isLocalRequest(localV6Req), true);
});
