import { URL } from 'url';

/**
 * 出站同步地址与桌面端安全校验工具（纯函数，不依赖数据库，便于单测）。
 */

/**
 * 校验同步目标 URL 格式与协议，仅允许合法的 http / https 地址。
 *
 * 注意：桌面端运行在用户本机，实际环境中经常使用局域网 NAS、Tailscale/WireGuard (100.64.0.0/10)
 * 或代理软件 Fake-IP (198.18.0.0/15) 连接同步服务，因此不做 DNS 私网/保留网段拦截；
 * 公网 SSRF 风险由 /api/v1/desktop/* 的登录鉴权 + 仅本机桌面端访问守卫从入口根治。
 */
export function assertSafeSyncOutboundUrl(rawUrl: string): URL {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) {
    throw new Error('目标服务器地址不能为空');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('目标服务器地址格式无效');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http 或 https 协议');
  }

  if (parsed.username || parsed.password) {
    throw new Error('目标服务器地址不允许包含内嵌认证凭据');
  }

  if (!parsed.hostname) {
    throw new Error('目标服务器地址缺少有效主机名');
  }

  return parsed;
}

/**
 * 判断两个 URL 是否属于同一源（协议、主机名、端口完全一致）。
 * 用于防止将本地已保存的同步密钥发送给不同源的目标主机。
 */
export function isSameOriginUrl(urlA?: string | null, urlB?: string | null): boolean {
  if (!urlA || !urlB) return false;
  try {
    const a = new URL(urlA.trim());
    const b = new URL(urlB.trim());
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * 对敏感密钥进行掩码脱敏展示，严禁在读接口明文回显。
 */
export function maskSecret(secret?: string | null): string {
  if (!secret || typeof secret !== 'string') return '';
  const trimmed = secret.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}

/**
 * 校验桌面端记忆路由，仅允许安全的站内相对路径，防止开放重定向或控制字符注入。
 */
export function isSafeDesktopRoute(route: unknown): route is string {
  if (typeof route !== 'string') return false;
  const trimmed = route.trim();
  if (!trimmed || trimmed.length > 512) return false;
  // 必须以单斜杠开头，拒绝协议相对路径（//evil.com）和反斜杠
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return false;
  }
  // 拒绝换行符及其他 ASCII 控制字符
  if (/[\r\n\0-\x1f\x7f]/.test(trimmed)) {
    return false;
  }
  return true;
}
