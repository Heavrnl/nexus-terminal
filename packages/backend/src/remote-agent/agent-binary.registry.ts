import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';

export type AgentOs = 'linux' | 'darwin' | 'windows' | 'freebsd';
export type AgentArch = 'x86_64' | 'aarch64' | 'armv7';

export interface AgentTargetManifestEntry {
  os: AgentOs;
  arch: AgentArch;
  filename: string;
  binaryName: string;
  rawSha256: string;
  gzipSha256: string;
  rawSize: number;
  gzipSize: number;
}

export interface AgentManifest {
  version: string;
  protocolVersion: number;
  generatedAt: string;
  targets: Record<string, AgentTargetManifestEntry>;
}

export interface ResolvedAgentBinary {
  version: string;
  protocolVersion: number;
  entry: AgentTargetManifestEntry;
  gzipPath: string;
  /** 解压后的原始可执行文件字节（校验过 rawSha256） */
  rawBuffer: Buffer;
}

/**
 * 探测内置 nexus-mux 多平台预编译二进制目录（兼容开发态、Docker 生产镜像与 Tauri 桌面端 Sidecar）。
 */
export function resolveAgentBinariesDir(): string | null {
  const candidates = [
    process.env.NEXUS_AGENT_BINARIES_DIR,
    path.resolve(__dirname, '../../agent-binaries'),
    path.resolve(__dirname, '../agent-binaries'),
    path.resolve(process.cwd(), 'agent-binaries'),
    path.resolve(__dirname, '../../../remote-agent/dist'),
    path.resolve(__dirname, '../../../../packages/remote-agent/dist'),
    path.resolve(process.cwd(), 'packages/remote-agent/dist'),
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'manifest.json'))) {
        return dir;
      }
    } catch {
      // 忽略无权访问目录
    }
  }
  return null;
}

class AgentBinaryRegistry {
  private cachedManifestPath: string | null = null;
  private cachedMtimeMs = 0;
  private cachedManifest: AgentManifest | null = null;
  private rawCache = new Map<string, Buffer>();

  public getManifest(): { dir: string; manifest: AgentManifest } | null {
    const dir = resolveAgentBinariesDir();
    if (!dir) return null;

    const manifestPath = path.join(dir, 'manifest.json');
    try {
      const stat = fs.statSync(manifestPath);
      if (
        this.cachedManifest &&
        this.cachedManifestPath === manifestPath &&
        this.cachedMtimeMs === stat.mtimeMs
      ) {
        return { dir, manifest: this.cachedManifest };
      }

      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AgentManifest;
      if (!parsed || typeof parsed.version !== 'string' || !parsed.targets) {
        return null;
      }

      this.cachedManifestPath = manifestPath;
      this.cachedMtimeMs = stat.mtimeMs;
      this.cachedManifest = parsed;
      this.rawCache.clear();
      return { dir, manifest: parsed };
    } catch (err: any) {
      console.warn('[AgentBinaryRegistry] 读取 manifest.json 失败:', err?.message || err);
      return null;
    }
  }

  public getTargetEntry(
    os: AgentOs,
    arch: AgentArch
  ): { dir: string; version: string; protocolVersion: number; entry: AgentTargetManifestEntry } | null {
    const loaded = this.getManifest();
    if (!loaded) return null;
    const key = `${os}-${arch}`;
    const entry = loaded.manifest.targets[key];
    if (!entry) return null;
    return {
      dir: loaded.dir,
      version: loaded.manifest.version,
      protocolVersion: loaded.manifest.protocolVersion,
      entry,
    };
  }

  /**
   * 获取指定平台的解压后可执行二进制（带 SHA256 完整性校验与内存缓存）。
   */
  public resolveBinaryForTarget(os: AgentOs, arch: AgentArch): ResolvedAgentBinary | null {
    const target = this.getTargetEntry(os, arch);
    if (!target) return null;

    const gzipPath = path.join(target.dir, target.entry.filename);
    if (!fs.existsSync(gzipPath)) {
      console.warn(`[AgentBinaryRegistry] 目标二进制文件缺失: ${gzipPath}`);
      return null;
    }

    const cacheKey = `${target.version}:${os}-${arch}`;
    let rawBuffer = this.rawCache.get(cacheKey);
    if (!rawBuffer) {
      const gzBuffer = fs.readFileSync(gzipPath);
      const actualGzHash = crypto.createHash('sha256').update(gzBuffer).digest('hex');
      if (target.entry.gzipSha256 && actualGzHash !== target.entry.gzipSha256.toLowerCase()) {
        throw new Error(`内置代理压缩包 SHA256 校验失败 (${target.entry.filename})`);
      }
      rawBuffer = zlib.gunzipSync(gzBuffer);
      const actualRawHash = crypto.createHash('sha256').update(rawBuffer).digest('hex');
      if (target.entry.rawSha256 && actualRawHash !== target.entry.rawSha256.toLowerCase()) {
        throw new Error(`内置代理二进制 SHA256 校验失败 (${target.entry.filename})`);
      }
      this.rawCache.set(cacheKey, rawBuffer);
    }

    return {
      version: target.version,
      protocolVersion: target.protocolVersion,
      entry: target.entry,
      gzipPath,
      rawBuffer,
    };
  }
}

export const agentBinaryRegistry = new AgentBinaryRegistry();
