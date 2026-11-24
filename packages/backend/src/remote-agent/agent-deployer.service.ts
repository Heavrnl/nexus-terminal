import { Client, SFTPWrapper } from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { agentBinaryRegistry, AgentArch, AgentOs, ResolvedAgentBinary } from './agent-binary.registry';
import {
  buildEnableLingerCommand,
  buildRemoteSha256Command,
  inferPlatformFamilyFromSftpHome,
  needsAgentDeploy,
  parseUnixProbeOutput,
  parseWindowsProbeOutput,
  shellQuoteUnix,
  TargetProbeResult,
  toSftpPath,
  UNIX_PROBE_SCRIPT,
  WINDOWS_PROBE_COMMAND,
} from './probe.pure';
import { MuxTransport } from './mux-transport';
import type { HostedSessionSummary } from './protocol';

export interface AgentDeployResult {
  ready: boolean;
  platformFamily?: 'unix' | 'windows';
  os?: AgentOs;
  arch?: AgentArch;
  binaryPath?: string;
  version?: string;
  deployedNow?: boolean;
  persistenceWarning?: string;
  fallbackReason?: string;
}

export interface EnsureAgentOptions {
  /** 单主机级唯一缓存键（通常 `${host}:${port}:${username}`） */
  hostCacheKey: string;
  /** 是否允许在目标机缺失/版本落后时自动推送安装 */
  autoDeploy: boolean;
  /** 是否跳过成功缓存强制重新探测 */
  forceReprobe?: boolean;
  /**
   * 前台最多等待多少毫秒（用于首次慢速上传时不阻塞用户进入终端）。
   * 超过该时长将先返回 ready=false 让调用方立刻打开传统 Shell，同时后台静默完成剩余部署并写入缓存。
   */
  foregroundWaitMs?: number;
}

const EXEC_TIMEOUT_MS = 10_000;
const SFTP_OP_TIMEOUT_MS = 8_000;
const DEPLOY_TIMEOUT_MS = 35_000;
const ENSURE_TOTAL_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 内存缓存 10 分钟
const DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 磁盘持久化缓存 7 天（重启桌面端也可 0 探测秒连）

interface CachedDeployEntry {
  result: AgentDeployResult;
  expiresAt: number;
}

interface PersistedHostCacheRecord {
  platformFamily: 'unix' | 'windows';
  os: AgentOs;
  arch: AgentArch;
  binaryPath: string;
  version: string;
  persistenceWarning?: string;
  updatedAt: number;
}

class SshDisconnectedError extends Error {
  constructor(message = '底层 SSH 连接已断开') {
    super(message);
    this.name = 'SshDisconnectedError';
  }
}

/** 绑定底层 sshClient 断开监听与超时定时器，确保任意 SSH/SFTP 操作在断链或卡死时必能及时 settle */
function runWithSshGuard<T>(
  sshClient: Client,
  timeoutMs: number,
  timeoutMessage: string,
  executor: (
    resolve: (value: T) => void,
    reject: (err: Error) => void,
    isSettled: () => boolean
  ) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      sshClient.off?.('close', onDisconnect);
      sshClient.off?.('end', onDisconnect);
      sshClient.off?.('error', onDisconnect);
    };

    const safeResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const safeReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onDisconnect = () => {
      safeReject(new SshDisconnectedError());
    };

    const timer = setTimeout(() => {
      safeReject(new Error(timeoutMessage));
    }, timeoutMs);
    timer.unref?.();

    sshClient.once?.('close', onDisconnect);
    sshClient.once?.('end', onDisconnect);
    sshClient.once?.('error', onDisconnect);

    try {
      executor(safeResolve, safeReject, () => settled);
    } catch (err: any) {
      safeReject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function execSshCommand(
  sshClient: Client,
  cmd: string,
  timeoutMs = EXEC_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return runWithSshGuard(
    sshClient,
    timeoutMs,
    `远程命令执行超时 (${timeoutMs}ms)`,
    (resolve, reject, isSettled) => {
      let stdout = '';
      let stderr = '';
      sshClient.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        if (isSettled()) {
          try { stream?.close?.(); } catch {}
          return;
        }
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('close', (code: number | null) => {
          resolve({ stdout, stderr, code });
        });
        stream.on('error', (streamErr: Error) => {
          reject(streamErr);
        });
      });
    }
  );
}

function openTempSftp(sshClient: Client, timeoutMs = SFTP_OP_TIMEOUT_MS): Promise<SFTPWrapper> {
  return runWithSshGuard(
    sshClient,
    timeoutMs,
    `打开临时 SFTP 通道超时 (${timeoutMs}ms)`,
    (resolve, reject, isSettled) => {
      sshClient.sftp((err, sftp) => {
        if (isSettled()) {
          try { sftp?.end(); } catch {}
          return;
        }
        if (err) return reject(err);
        resolve(sftp);
      });
    }
  );
}

function sftpRealpath(
  sshClient: Client,
  sftp: SFTPWrapper,
  p: string,
  timeoutMs = SFTP_OP_TIMEOUT_MS
): Promise<string> {
  return runWithSshGuard(
    sshClient,
    timeoutMs,
    `SFTP realpath 超时 (${timeoutMs}ms)`,
    (resolve, reject) => {
      const onSftpClose = () => reject(new SshDisconnectedError('临时 SFTP 通道已关闭'));
      sftp.once?.('close', onSftpClose);
      sftp.once?.('end', onSftpClose);
      sftp.realpath(p, (err, abs) => {
        sftp.off?.('close', onSftpClose);
        sftp.off?.('end', onSftpClose);
        if (err) return reject(err);
        resolve(abs);
      });
    }
  );
}

function sftpWriteBuffer(
  sshClient: Client,
  sftp: SFTPWrapper,
  remotePath: string,
  data: Buffer,
  mode?: number,
  timeoutMs = DEPLOY_TIMEOUT_MS
): Promise<void> {
  return runWithSshGuard(
    sshClient,
    timeoutMs,
    `SFTP 上传代理二进制超时 (${timeoutMs}ms)`,
    (resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath, {
        flags: 'w',
        ...(mode !== undefined ? { mode } : {}),
      });
      const onSftpClose = () => {
        try { ws.destroy(); } catch {}
        reject(new SshDisconnectedError('SFTP 写入期间通道提前关闭'));
      };
      const cleanSftp = () => {
        sftp.off?.('close', onSftpClose);
        sftp.off?.('end', onSftpClose);
      };
      sftp.once?.('close', onSftpClose);
      sftp.once?.('end', onSftpClose);
      ws.on('error', (e: Error) => {
        cleanSftp();
        reject(e);
      });
      ws.on('close', () => {
        cleanSftp();
        resolve();
      });
      ws.on('finish', () => {
        cleanSftp();
        resolve();
      });
      ws.end(data);
    }
  );
}

function sftpUnlink(sshClient: Client, sftp: SFTPWrapper, p: string, timeoutMs = 4000): Promise<void> {
  return runWithSshGuard<void>(
    sshClient,
    timeoutMs,
    `SFTP 删除临时文件超时 (${timeoutMs}ms)`,
    (resolve) => {
      const onSftpClose = () => resolve();
      sftp.once?.('close', onSftpClose);
      sftp.once?.('end', onSftpClose);
      sftp.unlink(p, () => {
        sftp.off?.('close', onSftpClose);
        sftp.off?.('end', onSftpClose);
        resolve();
      });
    }
  ).catch(() => {});
}

/** 通过 SSH exec stdin 逐块流式写入 Unix 目标文件（带背压 drain 控制，仅在 SFTP 不可用时兜底） */
function execUploadUnixBinary(
  sshClient: Client,
  tempPath: string,
  data: Buffer,
  compressedGzip = false
): Promise<void> {
  const cmd = compressedGzip
    ? `gzip -dc > ${shellQuoteUnix(tempPath)} && chmod 700 ${shellQuoteUnix(tempPath)}`
    : `cat > ${shellQuoteUnix(tempPath)} && chmod 700 ${shellQuoteUnix(tempPath)}`;
  return runWithSshGuard(
    sshClient,
    DEPLOY_TIMEOUT_MS,
    `通过 SSH exec 上传代理二进制超时 (${DEPLOY_TIMEOUT_MS}ms)`,
    (resolve, reject, isSettled) => {
      sshClient.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        if (isSettled()) {
          try { stream?.close?.(); } catch {}
          return;
        }
        let stderr = '';
        stream.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        stream.on('close', (code: number | null) => {
          if (code === 0) resolve();
          else reject(new Error(`SSH exec 写入失败 (code=${code}): ${stderr.trim()}`));
        });
        stream.on('error', (e: Error) => reject(e));

        // 按 16KB 切块写入并尊重 drain 背压，避免一次性 stream.end(大 Buffer) 触发 ssh2 窗口卡死
        const CHUNK_SIZE = 16 * 1024;
        let offset = 0;
        const pump = () => {
          if (isSettled()) return;
          while (offset < data.length) {
            const end = Math.min(offset + CHUNK_SIZE, data.length);
            const ok = stream.write(data.subarray(offset, end));
            offset = end;
            if (!ok) {
              stream.once('drain', pump);
              return;
            }
          }
          stream.end();
        };
        pump();
      });
    }
  );
}

interface InflightDeployEntry {
  ownerClient: Client;
  promise: Promise<{ result: AgentDeployResult; disconnected: boolean }>;
}

class AgentDeployerService {
  private readonly hostCache = new Map<string, CachedDeployEntry>();
  private readonly inflight = new Map<string, InflightDeployEntry>();

  public invalidateHostCache(hostCacheKey?: string): void {
    if (hostCacheKey) {
      this.hostCache.delete(hostCacheKey);
    } else {
      this.hostCache.clear();
    }
  }

  /**
   * 探测并在需要时自动向目标服务器部署 nexus-mux 二进制（同主机并发调用自动合流；
   * 若发起连接中途断开则立即释放合流槽，其他存活连接自动接力，绝不毒化后续重连）。
   */
  public async ensureAgentReady(
    sshClient: Client,
    options: EnsureAgentOptions
  ): Promise<AgentDeployResult> {
    const now = Date.now();
    if (!options.forceReprobe) {
      const cached = this.hostCache.get(options.hostCacheKey);
      if (cached && cached.expiresAt > now) {
        return cached.result;
      }
      const existingFlight = this.inflight.get(options.hostCacheKey);
      if (existingFlight && existingFlight.ownerClient !== sshClient) {
        const joined = await existingFlight.promise;
        // 若前一条发起连接是因为自身被关闭/断线而失败，当前活跃连接不连坐，直接接力重跑一次
        if (!joined.disconnected && joined.result.ready) {
          return joined.result;
        }
        if (!joined.disconnected) {
          return joined.result;
        }
      }
    }

    const wrappedPromise = this.runGuardedEnsure(sshClient, options);
    const entry: InflightDeployEntry = {
      ownerClient: sshClient,
      promise: wrappedPromise,
    };
    this.inflight.set(options.hostCacheKey, entry);

    try {
      const outcome = await wrappedPromise;
      // 仅对真实探测/部署结果做缓存；若因用户中途关闭标签页导致底层连接断开，不写入失败冷却缓存
      if (!outcome.disconnected) {
        this.hostCache.set(options.hostCacheKey, {
          result: outcome.result,
          expiresAt: Date.now() + (outcome.result.ready ? CACHE_TTL_MS : 60_000),
        });
      }
      return outcome.result;
    } finally {
      if (this.inflight.get(options.hostCacheKey) === entry) {
        this.inflight.delete(options.hostCacheKey);
      }
    }
  }

  /** 为整次 ensure 过程附加硬性总超时与断链守卫，杜绝任何漏网 Promise 永久挂起 */
  private async runGuardedEnsure(
    sshClient: Client,
    options: EnsureAgentOptions
  ): Promise<{ result: AgentDeployResult; disconnected: boolean }> {
    let settled = false;
    let totalTimer: NodeJS.Timeout | null = null;
    const onDisconnectRef: { fn?: () => void } = {};

    const abortGuard = new Promise<{ result: AgentDeployResult; disconnected: boolean }>((resolve) => {
      const onDisconnect = () => {
        if (settled) return;
        settled = true;
        resolve({
          disconnected: true,
          result: {
            ready: false,
            fallbackReason: '探测或部署期间底层 SSH 连接已断开',
          },
        });
      };
      onDisconnectRef.fn = onDisconnect;
      sshClient.once?.('close', onDisconnect);
      sshClient.once?.('end', onDisconnect);
      sshClient.once?.('error', onDisconnect);

      totalTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          disconnected: false,
          result: {
            ready: false,
            fallbackReason: `目标机托管代理探测/部署总耗时超过 ${ENSURE_TOTAL_TIMEOUT_MS / 1000}s，已自动降级传统 SSH 模式`,
          },
        });
      }, ENSURE_TOTAL_TIMEOUT_MS);
      totalTimer.unref?.();
    });

    const work = this.doEnsureAgentReady(sshClient, options)
      .then((res) => ({
        result: res,
        disconnected: false,
      }))
      .catch((err: any) => ({
        disconnected: err instanceof SshDisconnectedError,
        result: {
          ready: false,
          fallbackReason: `目标机托管代理初始化异常: ${err?.message || err}`,
        },
      }));

    try {
      const out = await Promise.race([work, abortGuard]);
      settled = true;
      return out;
    } finally {
      if (totalTimer) clearTimeout(totalTimer);
      if (onDisconnectRef.fn) {
        sshClient.off?.('close', onDisconnectRef.fn);
        sshClient.off?.('end', onDisconnectRef.fn);
        sshClient.off?.('error', onDisconnectRef.fn);
      }
    }
  }

  /** 探测目标机 OS/架构/安装目录/版本/linger 风险 */
  public async probeTarget(sshClient: Client): Promise<TargetProbeResult> {
    // 1. 优先用 SFTP realpath('.') 判断 Unix 还是 Windows（零 shell 语法兼容风险）
    let family: 'unix' | 'windows' | 'unknown' = 'unknown';
    let tempSftp: SFTPWrapper | null = null;
    try {
      tempSftp = await openTempSftp(sshClient, 6000);
      const home = await sftpRealpath(sshClient, tempSftp, '.', 6000);
      family = inferPlatformFamilyFromSftpHome(home);
    } catch {
      family = 'unknown';
    } finally {
      try { tempSftp?.end(); } catch {}
    }

    if (family === 'windows') {
      const winRes = await execSshCommand(sshClient, WINDOWS_PROBE_COMMAND);
      return parseWindowsProbeOutput(winRes.stdout);
    }

    // 2. Unix 优先探测；若失败且最初未通过 SFTP 判定，再兜底尝试 Windows 探测
    try {
      const unixRes = await execSshCommand(sshClient, UNIX_PROBE_SCRIPT);
      const parsed = parseUnixProbeOutput(unixRes.stdout);
      if (parsed.os && parsed.os !== 'windows') {
        return parsed;
      }
    } catch {
      // ignore and try Windows fallback if unknown
    }

    if (family === 'unknown') {
      try {
        const winRes = await execSshCommand(sshClient, WINDOWS_PROBE_COMMAND);
        const parsedWin = parseWindowsProbeOutput(winRes.stdout);
        if (parsedWin.os === 'windows') {
          return parsedWin;
        }
      } catch {
        // ignore
      }
    }

    return {
      platformFamily: 'unknown',
      os: null,
      arch: null,
      installDir: null,
      binaryPath: null,
      installedVersion: null,
      installedSha256: null,
      needsLingerFix: false,
      username: '',
      isRoot: false,
      hasPasswordlessSudo: false,
      hashTool: null,
    };
  }

  private async doEnsureAgentReady(
    sshClient: Client,
    options: EnsureAgentOptions
  ): Promise<AgentDeployResult> {
    let probe: TargetProbeResult;
    try {
      probe = await this.probeTarget(sshClient);
    } catch (err: any) {
      return {
        ready: false,
        fallbackReason: `目标机环境探测失败: ${err?.message || err}`,
      };
    }

    if (probe.platformFamily === 'unknown' || !probe.os || !probe.arch) {
      return {
        ready: false,
        fallbackReason: `未识别或暂不支持的目标系统 (${probe.os || 'unknown'}/${probe.arch || 'unknown'})`,
      };
    }

    if (!probe.binaryPath || !probe.installDir) {
      return {
        ready: false,
        fallbackReason: '目标机无可用且具备执行权限的安装目录（可能为只读或 noexec 分区）',
      };
    }

    // 检查内置二进制仓库是否包含该平台
    const targetEntry = agentBinaryRegistry.getTargetEntry(probe.os, probe.arch);

    // 尝试 Linux KillUserProcesses 免交互自动加固
    let persistenceWarning: string | undefined;
    if (probe.needsLingerFix) {
      const lingerCmd = buildEnableLingerCommand(probe);
      if (lingerCmd) {
        try {
          const fixRes = await execSshCommand(sshClient, lingerCmd, 8000);
          if (fixRes.code === 0) {
            console.log(`[AgentDeployer] 已为目标机用户 ${probe.username} 自动启用 systemd linger 加固。`);
            probe.needsLingerFix = false;
          }
        } catch (fixErr: any) {
          console.warn(`[AgentDeployer] 自动执行 linger 加固失败（已忽略）:`, fixErr?.message || fixErr);
        }
      }
      if (probe.needsLingerFix) {
        persistenceWarning =
          `检测到目标机启用了 systemd KillUserProcesses=yes 且用户 ${probe.username || '$USER'} 未开启 linger，` +
          `所有 SSH 断开后后台会话可能被终止；请执行: sudo loginctl enable-linger ${probe.username || '$USER'}`;
      }
    }

    // 情况 A：目标机已装好相同版本（或无内置仓库但目标机用户已手工安装兼容版本）
    if (probe.installedVersion && (!targetEntry || !needsAgentDeploy(probe.installedVersion, targetEntry.version))) {
      return {
        ready: true,
        platformFamily: probe.platformFamily,
        os: probe.os,
        arch: probe.arch,
        binaryPath: probe.binaryPath,
        version: probe.installedVersion,
        deployedNow: false,
        persistenceWarning,
      };
    }

    // 情况 B：需要部署但关闭了自动部署（若已有旧版且协议兼容，仍优先使用旧版）
    if (!options.autoDeploy) {
      if (probe.installedVersion) {
        return {
          ready: true,
          platformFamily: probe.platformFamily,
          os: probe.os,
          arch: probe.arch,
          binaryPath: probe.binaryPath,
          version: probe.installedVersion,
          deployedNow: false,
          persistenceWarning,
        };
      }
      return {
        ready: false,
        fallbackReason: '目标机未安装 nexus-mux 且已关闭自动部署',
      };
    }

    // 情况 C：未内置该目标架构的预编译产物
    let resolvedBinary: ResolvedAgentBinary | null = null;
    try {
      resolvedBinary = agentBinaryRegistry.resolveBinaryForTarget(probe.os, probe.arch);
    } catch (err: any) {
      return {
        ready: false,
        fallbackReason: `读取内置代理二进制校验异常: ${err?.message || err}`,
      };
    }

    if (!resolvedBinary) {
      if (probe.installedVersion) {
        return {
          ready: true,
          platformFamily: probe.platformFamily,
          os: probe.os,
          arch: probe.arch,
          binaryPath: probe.binaryPath,
          version: probe.installedVersion,
          deployedNow: false,
          persistenceWarning,
        };
      }
      return {
        ready: false,
        fallbackReason: `未内置 ${probe.os}-${probe.arch} 平台的 nexus-mux 二进制，已降级传统 SSH 模式`,
      };
    }

    // 情况 D：通过已建 SSH/SFTP 通道安全推送 + SHA256 校验 + 原子替换
    try {
      await this.uploadAndVerifyBinary(sshClient, probe, resolvedBinary);
      console.log(
        `[AgentDeployer] 已向目标机 (${options.hostCacheKey}, ${probe.os}-${probe.arch}) 部署 nexus-mux v${resolvedBinary.version} -> ${probe.binaryPath}`
      );
      return {
        ready: true,
        platformFamily: probe.platformFamily,
        os: probe.os,
        arch: probe.arch,
        binaryPath: probe.binaryPath,
        version: resolvedBinary.version,
        deployedNow: true,
        persistenceWarning,
      };
    } catch (deployErr: any) {
      console.warn(`[AgentDeployer] 自动部署 nexus-mux 失败，降级传统模式:`, deployErr?.message || deployErr);
      // 若旧版仍存在且可用，继续兜底复用旧版
      if (probe.installedVersion) {
        return {
          ready: true,
          platformFamily: probe.platformFamily,
          os: probe.os,
          arch: probe.arch,
          binaryPath: probe.binaryPath,
          version: probe.installedVersion,
          deployedNow: false,
          persistenceWarning,
        };
      }
      return {
        ready: false,
        fallbackReason: `自动部署失败: ${deployErr?.message || deployErr}`,
      };
    }
  }

  private async uploadAndVerifyBinary(
    sshClient: Client,
    probe: TargetProbeResult,
    binary: ResolvedAgentBinary
  ): Promise<void> {
    const suffix = crypto.randomBytes(4).toString('hex');
    const binaryPath = probe.binaryPath!;
    const tempFsPath = `${binaryPath}.${suffix}.tmp`;
    const expectedSha256 = binary.entry.rawSha256.toLowerCase();

    // Unix 且目标机存在 gzip 时，优先直接传输 ~420KB 的 .gz 压缩包并远端解压，显著提升跨国高延迟线路成功率
    let gzipBuffer: Buffer | null = null;
    if (probe.platformFamily === 'unix' && probe.hasGzip && binary.gzipPath) {
      try {
        gzipBuffer = fs.readFileSync(binary.gzipPath);
      } catch {
        gzipBuffer = null;
      }
    }

    let uploaded = false;
    if (gzipBuffer) {
      try {
        await execUploadUnixBinary(sshClient, tempFsPath, gzipBuffer, true);
        uploaded = true;
      } catch (gzErr: any) {
        console.warn(`[AgentDeployer] Unix gzip 压缩流直传失败，回退 SFTP/原始流上传:`, gzErr?.message || gzErr);
        await this.cleanupTempFile(sshClient, probe, tempFsPath);
      }
    }

    if (!uploaded) {
      let uploadedViaSftp = false;
      let sftp: SFTPWrapper | null = null;
      try {
        sftp = await openTempSftp(sshClient, 8000);
        const tempSftpPath = toSftpPath(probe.platformFamily as 'unix' | 'windows', tempFsPath);
        await sftpWriteBuffer(
          sshClient,
          sftp,
          tempSftpPath,
          binary.rawBuffer,
          probe.platformFamily === 'unix' ? 0o700 : undefined,
          DEPLOY_TIMEOUT_MS
        );
        uploadedViaSftp = true;
      } catch (sftpErr: any) {
        if (probe.platformFamily === 'windows') {
          throw new Error(`Windows SFTP 上传代理失败: ${sftpErr?.message || sftpErr}`);
        }
        console.warn(`[AgentDeployer] SFTP 上传失败，尝试 Unix SSH exec 管道上传:`, sftpErr?.message || sftpErr);
      } finally {
        try { sftp?.end(); } catch {}
      }

      if (!uploadedViaSftp && probe.platformFamily === 'unix') {
        await execUploadUnixBinary(sshClient, tempFsPath, binary.rawBuffer, false);
      }
    }

    // 校验目标机落地文件的 SHA256
    const hashCmd = buildRemoteSha256Command(probe, tempFsPath);
    if (hashCmd) {
      const hashRes = await execSshCommand(sshClient, hashCmd, 12_000);
      const actualHash = (hashRes.stdout || '').trim().toLowerCase().split(/\s+/)[0];
      if (!actualHash || actualHash !== expectedSha256) {
        await this.cleanupTempFile(sshClient, probe, tempFsPath);
        throw new Error(`目标机 SHA256 校验不匹配 (expected=${expectedSha256.slice(0, 12)}, actual=${actualHash.slice(0, 12)})`);
      }
    }

    // 原子替换目标二进制（Unix 替换磁盘 inode 不影响正在运行中的老 Daemon 内存镜像；Windows 若旧文件被锁定则保留重命名兜底）
    if (probe.platformFamily === 'unix') {
      const mvCmd = `chmod 700 ${shellQuoteUnix(tempFsPath)} && mv -f ${shellQuoteUnix(tempFsPath)} ${shellQuoteUnix(binaryPath)}`;
      const mvRes = await execSshCommand(sshClient, mvCmd, 10_000);
      if (mvRes.code !== 0) {
        await this.cleanupTempFile(sshClient, probe, tempFsPath);
        throw new Error(`原子替换代理二进制失败: ${mvRes.stderr.trim()}`);
      }
    } else {
      const escapedTmp = tempFsPath.replace(/'/g, "''");
      const escapedDst = binaryPath.replace(/'/g, "''");
      const escapedOld = `${binaryPath}.old`.replace(/'/g, "''");
      // Windows 正在运行的 exe 不能直接删除，但可以重命名为 .old 后把新文件原子迁入原名！
      const winSwap =
        'powershell -NoProfile -NonInteractive -Command "' +
        `if (Test-Path -LiteralPath '${escapedOld}') { Remove-Item -LiteralPath '${escapedOld}' -Force -ErrorAction SilentlyContinue }; ` +
        `if (Test-Path -LiteralPath '${escapedDst}') { Move-Item -LiteralPath '${escapedDst}' -Destination '${escapedOld}' -Force }; ` +
        `Move-Item -LiteralPath '${escapedTmp}' -Destination '${escapedDst}' -Force` +
        '"';
      const swapRes = await execSshCommand(sshClient, winSwap, 12_000);
      if (swapRes.code !== 0) {
        await this.cleanupTempFile(sshClient, probe, tempFsPath);
        throw new Error(`Windows 替换代理二进制失败: ${swapRes.stderr.trim()}`);
      }
    }
  }

  private async cleanupTempFile(sshClient: Client, probe: TargetProbeResult, tempFsPath: string): Promise<void> {
    try {
      const sftp = await openTempSftp(sshClient, 4000);
      await sftpUnlink(sshClient, sftp, toSftpPath(probe.platformFamily as 'unix' | 'windows', tempFsPath), 4000);
      sftp.end();
    } catch {
      // ignore
    }
  }

  /** 扫描目标机上存活的托管会话列表（用于孤儿认领与托管状态核对） */
  public async scanRemoteHostedSessions(
    sshClient: Client,
    ownerNamespace: string,
    includeAllNamespaces = false
  ): Promise<{ installed: boolean; sessions: HostedSessionSummary[]; version?: string }> {
    const probe = await this.probeTarget(sshClient);
    if (probe.platformFamily === 'unknown' || !probe.binaryPath || !probe.installedVersion) {
      return { installed: false, sessions: [] };
    }
    const transport = await MuxTransport.connect(sshClient, {
      platformFamily: probe.platformFamily,
      binaryPath: probe.binaryPath,
      ownerNamespace,
      clientId: 'scanner',
    });
    try {
      const sessions = await transport.listSessions(includeAllNamespaces);
      return {
        installed: true,
        sessions,
        version: probe.installedVersion,
      };
    } finally {
      transport.destroy();
    }
  }

  /** 通过临时连接终止目标机上的某条指定托管会话 */
  public async killRemoteHostedSession(
    sshClient: Client,
    ownerNamespace: string,
    remoteSessionId: string,
    forceAnyNamespace = false
  ): Promise<boolean> {
    const probe = await this.probeTarget(sshClient);
    if (probe.platformFamily === 'unknown' || !probe.binaryPath || !probe.installedVersion) {
      return false;
    }
    const transport = await MuxTransport.connect(sshClient, {
      platformFamily: probe.platformFamily,
      binaryPath: probe.binaryPath,
      ownerNamespace,
      clientId: 'killer',
    });
    try {
      transport.killRemoteSession(remoteSessionId, forceAnyNamespace);
      // 稍等 150ms 让控制帧送达并落盘
      await new Promise((r) => setTimeout(r, 150));
      return true;
    } finally {
      transport.destroy();
    }
  }

  /** 一键停止目标机 nexus-mux Daemon 并彻底卸载清理二进制与运行时目录 */
  public async uninstallAgent(sshClient: Client, hostCacheKey?: string): Promise<{ removedPaths: string[] }> {
    const probe = await this.probeTarget(sshClient);
    const removedPaths: string[] = [];

    if (probe.platformFamily === 'windows') {
      const bin = probe.binaryPath;
      if (bin) {
        try {
          await execSshCommand(sshClient, `"${bin.replace(/"/g, '\\"')}" stop-daemon`, 6000);
        } catch {}
      }
      const cleanCmd =
        'powershell -NoProfile -NonInteractive -Command "' +
        "$base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $env:TEMP }; " +
        "$root = Join-Path $base 'nexus-terminal'; " +
        "if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue; Write-Output $root }" +
        '"';
      const res = await execSshCommand(sshClient, cleanCmd, 10_000);
      const out = (res.stdout || '').trim();
      if (out) removedPaths.push(out);
    } else if (probe.platformFamily === 'unix') {
      if (probe.binaryPath) {
        try {
          await execSshCommand(sshClient, `${shellQuoteUnix(probe.binaryPath)} stop-daemon`, 6000);
        } catch {}
      }
      const cleanCmd = [
        'for d in "$HOME/.nexus-terminal" "${XDG_DATA_HOME:-$HOME/.local/share}/nexus-terminal" "${XDG_RUNTIME_DIR:-/nonexistent}/nexus-mux" "/tmp/.nexus-terminal-$(id -un 2>/dev/null || id -u 2>/dev/null)" "/tmp/nexus-mux-$(id -u 2>/dev/null)"; do',
        '  if [ -e "$d" ]; then rm -rf "$d" 2>/dev/null && printf "%s\\n" "$d"; fi',
        'done',
      ].join('\n');
      const res = await execSshCommand(sshClient, cleanCmd, 10_000);
      for (const line of (res.stdout || '').split(/\r?\n/)) {
        if (line.trim()) removedPaths.push(line.trim());
      }
    }

    this.invalidateHostCache(hostCacheKey);
    return { removedPaths };
  }
}

export const agentDeployerService = new AgentDeployerService();
