import dns from 'dns/promises';
import ipaddr from 'ipaddr.js';
import { URL } from 'url';

/**
 * 出站同步地址与桌面端安全校验工具（纯函数为主，不依赖数据库，便于单测）。
 */

export interface VerifiedOutboundTarget {
  url: URL;
  /** 若目标为域名且已完成 DNS 解析，返回校验通过的首个 IP，供 socket 连接复用以防 DNS Rebinding */
  resolvedAddress?: string;
  family?: 4 | 6;
}

export type LookupAllFn = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookupAll: LookupAllFn = async (hostname: string) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((item) => ({ address: item.address, family: item.family }));
};

/**
 * 判断是否通过部署环境变量显式放行内网/回环同步地址。
 * 默认严格关闭，仅限确有纯内网自建需求或本地联调时由部署者显式开启。
 */
export function isPrivateSyncUrlAllowed(): boolean {
  const raw = (process.env.ALLOW_PRIVATE_SYNC_URL || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * 判断给定 IP 字符串是否为公网单播地址。
 * 拒绝回环、私网、链路本地、ULA、CGNAT、未指定地址、多播、保留地址及 IPv4-mapped 私有地址。
 */
export function isPublicIpAddress(rawIp: string): boolean {
  const trimmed = rawIp.trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return false;
  // 去掉 IPv6 zone index（如 fe80::1%eth0）
  const ip = trimmed.split('%')[0];
  if (!ipaddr.isValid(ip)) return false;

  try {
    let parsed = ipaddr.parse(ip);
    // 若为 IPv4 映射的 IPv6（如 ::ffff:127.0.0.1），解包回 IPv4 再判断
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

/**
 * 判断是否为明显的本机或局域网保留域名
 */
function isLocalOnlyHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  );
}

/**
 * 校验同步出站目标 URL 是否安全，阻断 SSRF（回环、内网、云元数据、非 HTTP(S) 协议等）。
 */
export async function assertSafeSyncOutboundUrl(
  rawUrl: string,
  options?: {
    allowPrivate?: boolean;
    lookupFn?: LookupAllFn;
  }
): Promise<VerifiedOutboundTarget> {
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

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new Error('目标服务器地址缺少有效主机名');
  }

  const allowPrivate = options?.allowPrivate ?? isPrivateSyncUrlAllowed();
  if (allowPrivate) {
    return { url: parsed };
  }

  if (isLocalOnlyHostname(hostname)) {
    throw new Error('不允许连接本机或局域网保留域名');
  }

  // URL 构造器已将整数/八进制/十六进制 IPv4 归一化为标准点分十进制，直接检测是否为 IP 字面量
  if (ipaddr.isValid(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new Error('目标地址不允许指向内网、回环或保留网段');
    }
    const family: 4 | 6 = ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4;
    return { url: parsed, resolvedAddress: hostname, family };
  }

  // 对域名进行 DNS 解析，校验全部解析结果均属于公网单播地址
  const lookupFn = options?.lookupFn ?? defaultLookupAll;
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(hostname);
  } catch {
    throw new Error('目标服务器域名解析失败');
  }

  if (!records || records.length === 0) {
    throw new Error('目标服务器域名未解析到有效地址');
  }

  for (const record of records) {
    if (!isPublicIpAddress(record.address)) {
      throw new Error('目标域名解析到了不允许的内网、回环或保留地址');
    }
  }

  const first = records[0];
  return {
    url: parsed,
    resolvedAddress: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

/**
 * 构造绑定到已校验 IP 的 Node http/https/ws lookup 回调，防止 TOCTOU DNS Rebinding。
 */
export function createPinnedLookup(target: VerifiedOutboundTarget) {
  if (!target.resolvedAddress || !target.family) {
    return undefined;
  }
  const address = target.resolvedAddress;
  const family = target.family;
  return (
    _hostname: string,
    optsOrCb: any,
    maybeCb?: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
  ) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    const options = typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb : {};
    if (!callback) return;
    if (options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
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
