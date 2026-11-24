import { Client, SFTPWrapper } from 'ssh2';
import crypto from 'crypto';
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
}

const EXEC_TIMEOUT_MS = 12_000;
const DEPLOY_TIMEOUT_MS = 35_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟内同主机复用探测结果，避免重复 exec 探测

interface CachedDeployEntry {
  result: AgentDeployResult;
  expiresAt: number;
}

function execSshCommand(
  sshClient: Client,
  cmd: string,
  timeoutMs = EXEC_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`远程命令执行超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    timer.unref?.();

    sshClient.exec(cmd, (err, stream) => {
      if (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        return;
      }
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        }
      });
      stream.on('error', (streamErr: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(streamErr);
        }
      });
    });
  });
}

function openTempSftp(sshClient: Client, timeoutMs = 8000): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('打开临时 SFTP 通道超时'));
      }
    }, timeoutMs);
    timer.unref?.();

    sshClient.sftp((err, sftp) => {
      if (settled) {
        try { sftp?.end(); } catch {}
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

function sftpRealpath(sftp: SFTPWrapper, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => {
      if (err) return reject(err);
      resolve(abs);
    });
  });
}

function sftpWriteBuffer(sftp: SFTPWrapper, remotePath: string, data: Buffer, mode?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remotePath, {
      flags: 'w',
      ...(mode !== undefined ? { mode } : {}),
    });
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve();
    };
    ws.on('error', (e: Error) => finish(e));
    ws.on('close', () => finish());
    ws.end(data);
  });
}

function sftpRename(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function sftpUnlink(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.unlink(p, () => resolve());
  });
}

/** 通过 SSH exec stdin 流式写入 Unix 目标文件（当目标机禁用了 SFTP 子系统时的兜底方案） */
function execUploadUnixBinary(sshClient: Client, tempPath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = `cat > ${shellQuoteUnix(tempPath)} && chmod 700 ${shellQuoteUnix(tempPath)}`;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('通过 SSH exec 上传代理二进制超时'));
      }
    }, DEPLOY_TIMEOUT_MS);
    timer.unref?.();

    sshClient.exec(cmd, (err, stream) => {
      if (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        return;
      }
      let stderr = '';
      stream.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      stream.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`SSH exec 写入失败 (code=${code}): ${stderr.trim()}`));
      });
      stream.on('error', (e: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });
      stream.end(data);
    });
  });
}

class AgentDeployerService {
  private readonly hostCache = new Map<string, CachedDeployEntry>();
  private readonly inflight = new Map<string, Promise<AgentDeployResult>>();

  public invalidateHostCache(hostCacheKey?: string): void {
    if (hostCacheKey) {
      this.hostCache.delete(hostCacheKey);
    } else {
      this.hostCache.clear();
    }
  }

  /**
   * 探测并在需要时自动向目标服务器部署 nexus-mux 二进制（同主机并发调用自动合流，失败安全降级）。
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
      if (existingFlight) {
        return existingFlight;
      }
    }

    const task = this.doEnsureAgentReady(sshClient, options)
      .then((res) => {
        // 成功结果缓存 10 分钟；失败结果短暂缓存 60 秒避免连续重试拖慢连接
        this.hostCache.set(options.hostCacheKey, {
          result: res,
          expiresAt: Date.now() + (res.ready ? CACHE_TTL_MS : 60_000),
        });
        return res;
      })
      .finally(() => {
        this.inflight.delete(options.hostCacheKey);
      });

    this.inflight.set(options.hostCacheKey, task);
    return task;
  }

  /** 探测目标机 OS/架构/安装目录/版本/linger 风险 */
  public async probeTarget(sshClient: Client): Promise<TargetProbeResult> {
    // 1. 优先用 SFTP realpath('.') 判断 Unix 还是 Windows（零 shell 语法兼容风险）
    let family: 'unix' | 'windows' | 'unknown' = 'unknown';
    let tempSftp: SFTPWrapper | null = null;
    try {
      tempSftp = await openTempSftp(sshClient, 6000);
      const home = await sftpRealpath(tempSftp, '.');
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
    const tempFsPath =
      probe.platformFamily === 'windows'
        ? `${binaryPath}.${suffix}.tmp`
        : `${binaryPath}.${suffix}.tmp`;
    const expectedSha256 = binary.entry.rawSha256.toLowerCase();

    let uploadedViaSftp = false;
    let sftp: SFTPWrapper | null = null;
    try {
      sftp = await openTempSftp(sshClient, 8000);
      const tempSftpPath = toSftpPath(probe.platformFamily as 'unix' | 'windows', tempFsPath);
      await sftpWriteBuffer(
        sftp,
        tempSftpPath,
        binary.rawBuffer,
        probe.platformFamily === 'unix' ? 0o700 : undefined
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
      await execUploadUnixBinary(sshClient, tempFsPath, binary.rawBuffer);
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
      await sftpUnlink(sftp, toSftpPath(probe.platformFamily as 'unix' | 'windows', tempFsPath));
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
