/**
 * 远程主机状态监控复合采样命令与纯解析函数。
 *
 * 将原本每轮串行发起的 7~9 个独立 SSH exec 通道合并为：
 *   - 静态主机信息（OS / CPU 型号 / 默认网卡）：每会话仅采样 1 次并缓存；
 *   - 动态指标（Mem / CPU / LoadAvg / Net / Disk）：每轮合并为 1 条复合命令，
 *     显著降低 SSH channel 竞争、远端 fork 开销与弱网超时概率。
 */

export const COMBINED_DYNAMIC_STATUS_CMD =
  "printf '__NX_MEM__\\n'; cat /proc/meminfo 2>/dev/null; " +
  "printf '\\n__NX_STAT__\\n'; head -n 1 /proc/stat 2>/dev/null; " +
  "printf '\\n__NX_LOAD__\\n'; cat /proc/loadavg 2>/dev/null; " +
  "printf '\\n__NX_NET__\\n'; cat /proc/net/dev 2>/dev/null; " +
  "printf '\\n__NX_DF__\\n'; LC_ALL=C df -kP / 2>/dev/null || LC_ALL=C df -k / 2>/dev/null";

export const COMBINED_STATIC_HOST_INFO_CMD =
  "printf '__NX_OS__\\n'; cat /etc/os-release 2>/dev/null; " +
  "printf '\\n__NX_CPU__\\n'; (grep -m 1 'model name' /proc/cpuinfo 2>/dev/null || LC_ALL=C lscpu 2>/dev/null | grep -m 1 'Model name:'); " +
  "printf '\\n__NX_IFACE__\\n'; ip route get 1.1.1.1 2>/dev/null | head -n 1";

export interface StaticHostInfo {
  osName?: string;
  cpuModel?: string;
  defaultInterface?: string;
}

export interface DynamicStatusSections {
  meminfo: string;
  stat: string;
  loadavg: string;
  netdev: string;
  df: string;
}

/** 按标记切分复合命令的多段输出 */
export function splitMarkedSections(output: string, markers: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of markers) result[m] = '';
  if (!output) return result;

  const positions: Array<{ marker: string; start: number; contentStart: number }> = [];
  for (const marker of markers) {
    const idx = output.indexOf(marker);
    if (idx !== -1) {
      let contentStart = idx + marker.length;
      if (output[contentStart] === '\r') contentStart += 1;
      if (output[contentStart] === '\n') contentStart += 1;
      positions.push({ marker, start: idx, contentStart });
    }
  }
  positions.sort((a, b) => a.start - b.start);

  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const nextStart = i + 1 < positions.length ? positions[i + 1].start : output.length;
    result[cur.marker] = output.slice(cur.contentStart, nextStart).trim();
  }
  return result;
}

export function parseStaticHostInfoOutput(output: string): StaticHostInfo {
  const sections = splitMarkedSections(output, ['__NX_OS__', '__NX_CPU__', '__NX_IFACE__']);
  const info: StaticHostInfo = {};

  const osRaw = sections.__NX_OS__;
  if (osRaw) {
    const pretty = osRaw.match(/^PRETTY_NAME="?([^"\r\n]+)"?/m);
    const name = osRaw.match(/^NAME="?([^"\r\n]+)"?/m);
    info.osName = pretty ? pretty[1].trim() : (name ? name[1].trim() : undefined);
  }

  const cpuRaw = sections.__NX_CPU__;
  if (cpuRaw) {
    const procMatch = cpuRaw.match(/model name\s*:\s*(.+)/i);
    if (procMatch && procMatch[1]) {
      info.cpuModel = procMatch[1].trim();
    }
  }

  const ifaceRaw = sections.__NX_IFACE__;
  if (ifaceRaw) {
    const devMatch = ifaceRaw.match(/\bdev\s+(\S+)/);
    if (devMatch && devMatch[1]) {
      info.defaultInterface = devMatch[1].trim();
    }
  }

  return info;
}

export function parseDynamicStatusSections(output: string): DynamicStatusSections {
  const sections = splitMarkedSections(output, [
    '__NX_MEM__',
    '__NX_STAT__',
    '__NX_LOAD__',
    '__NX_NET__',
    '__NX_DF__',
  ]);
  return {
    meminfo: sections.__NX_MEM__,
    stat: sections.__NX_STAT__,
    loadavg: sections.__NX_LOAD__,
    netdev: sections.__NX_NET__,
    df: sections.__NX_DF__,
  };
}

/** 从 `/proc/loadavg` 文本（形如 `0.15 0.20 0.18 1/234 5678`）解析三维平均负载 */
export function parseProcLoadavg(output: string): number[] | undefined {
  if (!output) return undefined;
  const match = output.trim().match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!match) return undefined;
  const nums = [parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])];
  return nums.every((n) => Number.isFinite(n)) ? nums : undefined;
}

/** 从 `df -kP /` 或 `df -k /` 输出解析根分区容量与已用百分比 */
export function parseRootDiskUsage(dfOutput: string): { diskTotal: number; diskUsed: number; diskPercent: number } | null {
  if (!dfOutput) return null;
  const lines = dfOutput.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.endsWith(' /')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const total = parseInt(parts[1], 10);
    const used = parseInt(parts[2], 10);
    const percentStr = parts.find((p) => p.endsWith('%'));
    const percentMatch = percentStr?.match(/(\d+)%/);
    if (!isNaN(total) && !isNaN(used) && percentMatch && percentMatch[1]) {
      return {
        diskTotal: total,
        diskUsed: used,
        diskPercent: parseFloat(percentMatch[1]),
      };
    }
  }
  return null;
}

/** 从 `/proc/net/dev` 文本解析各网卡收发字节数 */
export function parseProcNetDevText(output: string): Record<string, { rx_bytes: number; tx_bytes: number }> | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/).slice(2);
  const stats: Record<string, { rx_bytes: number; tx_bytes: number }> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/:\s*|\s+/).filter(Boolean);
    if (parts.length < 10) continue;
    const interfaceName = parts[0];
    const rx_bytes = parseInt(parts[1], 10);
    const tx_bytes = parseInt(parts[9], 10);
    if (!isNaN(rx_bytes) && !isNaN(tx_bytes)) {
      stats[interfaceName] = { rx_bytes, tx_bytes };
    }
  }
  return Object.keys(stats).length > 0 ? stats : null;
}
