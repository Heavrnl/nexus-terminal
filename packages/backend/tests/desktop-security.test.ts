import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSafeSyncOutboundUrl,
  isPublicIpAddress,
  isSafeDesktopRoute,
  isSameOriginUrl,
  maskSecret,
} from '../src/sync/outbound-url.ts';
import { isLocalRequest } from '../src/auth/session-policy.ts';

test('isPublicIpAddress：阻断全部内网、回环、元数据与保留地址，放行公网地址', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.8',
    '::ffff:192.168.1.10',
    '::ffff:169.254.169.254',
    'invalid-ip',
    '',
  ];
  for (const ip of blocked) {
    assert.equal(isPublicIpAddress(ip), false, `应当拒绝非公网地址: ${ip}`);
  }

  const allowed = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'];
  for (const ip of allowed) {
    assert.equal(isPublicIpAddress(ip), true, `应当放行公网地址: ${ip}`);
  }
});

test('assertSafeSyncOutboundUrl：阻断非法协议、内嵌凭据、本机与私网地址及变形 IP', async () => {
  const rejectedUrls = [
    '',
    'not-a-url',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_INFO',
    'ftp://example.com/file',
    'https://user:pass@example.com',
    'http://localhost:3001',
    'http://sub.localhost:3001',
    'http://nas.local:3001',
    'http://127.0.0.1:3001/api/v1/status',
    'http://0x7f000001:3001',
    'http://2130706433:3001',
    'http://10.0.0.5:3001',
    'http://172.16.1.2:3001',
    'http://192.168.1.100:3001',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:3001',
    'http://[::ffff:127.0.0.1]:3001',
  ];

  for (const target of rejectedUrls) {
    await assert.rejects(
      () => assertSafeSyncOutboundUrl(target, { allowPrivate: false }),
      `应当阻断不安全出站地址: ${target}`
    );
  }
});

test('assertSafeSyncOutboundUrl：DNS 解析结果含任一内网地址时拒绝，全部公网时放行并固定 IP', async () => {
  await assert.rejects(
    () =>
      assertSafeSyncOutboundUrl('https://rebind.example.com', {
        allowPrivate: false,
        lookupFn: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    /内网|回环|保留/
  );

  const ok = await assertSafeSyncOutboundUrl('https://sync.example.com:8443/nexus', {
    allowPrivate: false,
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(ok.url.origin, 'https://sync.example.com:8443');
  assert.equal(ok.resolvedAddress, '93.184.216.34');
  assert.equal(ok.family, 4);

  const privateAllowed = await assertSafeSyncOutboundUrl('http://127.0.0.1:3001', {
    allowPrivate: true,
  });
  assert.equal(privateAllowed.url.origin, 'http://127.0.0.1:3001');
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
