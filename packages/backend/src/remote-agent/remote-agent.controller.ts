import { Request, Response } from 'express';
import * as SshService from '../services/ssh.service';
import { agentBinaryRegistry } from './agent-binary.registry';
import { agentDeployerService } from './agent-deployer.service';
import { getOrCreateOwnerNamespace } from './owner-namespace.service';
import { remoteHostedSessionRepository } from './remote-hosted-session.repository';

/**
 * 获取当前服务端内置的 nexus-mux 多平台二进制清单信息
 */
export async function getRemoteAgentStatus(_req: Request, res: Response): Promise<void> {
  const loaded = agentBinaryRegistry.getManifest();
  const ns = await getOrCreateOwnerNamespace();
  const availableTargets = loaded
    ? Object.values(loaded.manifest.targets).map((t) => ({
        os: t.os,
        arch: t.arch,
        version: loaded.manifest.version,
      }))
    : [];
  res.json({
    success: true,
    data: {
      available: Boolean(loaded),
      version: loaded?.manifest.version ?? null,
      protocolVersion: loaded?.manifest.protocolVersion ?? 1,
      targets: loaded ? Object.keys(loaded.manifest.targets) : [],
      availableTargets,
      ownerNamespace: ns.ownerNamespace,
    },
  });
}

/**
 * 扫描指定主机上当前存活的 nexus-mux 托管会话（支持勾选查看同 OS 用户下全部命名空间）
 */
export async function scanConnectionRemoteSessions(req: Request, res: Response): Promise<void> {
  const connectionId = Number(req.params.id);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    res.status(400).json({ success: false, message: '无效的连接 ID' });
    return;
  }
  const includeAll = req.body?.includeAllNamespaces === true || req.query?.includeAll === 'true';

  let sshClient: any = null;
  try {
    const connDetails = await SshService.getConnectionDetails(connectionId);
    const { ownerNamespace } = await getOrCreateOwnerNamespace();
    sshClient = await SshService.establishSshConnection(connDetails);
    const result = await agentDeployerService.scanRemoteHostedSessions(
      sshClient,
      ownerNamespace,
      includeAll
    );
    res.json({
      success: true,
      data: {
        connectionId,
        connectionName: connDetails.name,
        ownerNamespace,
        ...result,
        sessions: result.sessions.map((s) => ({
          ...s,
          sessionId: s.remoteSessionId,
          status: s.exited ? 'exited' : 'running',
        })),
      },
    });
  } catch (err: any) {
    console.error(`[RemoteAgentController] 扫描主机 ${connectionId} 托管会话失败:`, err?.message || err);
    res.status(502).json({
      success: false,
      message: `扫描目标机托管会话失败: ${err?.message || err}`,
    });
  } finally {
    try { sshClient?.end(); } catch {}
  }
}

/**
 * 直接终止指定主机上的某条目标机托管会话（同时清理持久化挂起记录）
 */
export async function killConnectionRemoteSession(req: Request, res: Response): Promise<void> {
  const connectionId = Number(req.params.id);
  const remoteSessionId = String(req.params.remoteSessionId || '').trim();
  const forceAnyNamespace = req.body?.forceAnyNamespace === true || req.query?.force === 'true';

  if (!Number.isInteger(connectionId) || connectionId <= 0 || !remoteSessionId) {
    res.status(400).json({ success: false, message: '缺少有效的连接 ID 或 remoteSessionId' });
    return;
  }

  let sshClient: any = null;
  try {
    const connDetails = await SshService.getConnectionDetails(connectionId);
    const { ownerNamespace } = await getOrCreateOwnerNamespace();
    sshClient = await SshService.establishSshConnection(connDetails);
    const killed = await agentDeployerService.killRemoteHostedSession(
      sshClient,
      ownerNamespace,
      remoteSessionId,
      forceAnyNamespace
    );
    await remoteHostedSessionRepository.deleteByRemoteSessionId(remoteSessionId).catch(() => {});
    res.json({
      success: true,
      data: { killed, remoteSessionId },
    });
  } catch (err: any) {
    console.error(`[RemoteAgentController] 终止目标机会话 ${remoteSessionId} 失败:`, err?.message || err);
    res.status(502).json({
      success: false,
      message: `终止目标机托管会话失败: ${err?.message || err}`,
    });
  } finally {
    try { sshClient?.end(); } catch {}
  }
}

/**
 * 一键停止并卸载目标主机上的 nexus-mux 托管代理及运行时目录
 */
export async function uninstallConnectionRemoteAgent(req: Request, res: Response): Promise<void> {
  const connectionId = Number(req.params.id);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    res.status(400).json({ success: false, message: '无效的连接 ID' });
    return;
  }

  let sshClient: any = null;
  try {
    const connDetails = await SshService.getConnectionDetails(connectionId);
    const hostCacheKey = `${connDetails.host}:${connDetails.port}:${connDetails.username}`;
    sshClient = await SshService.establishSshConnection(connDetails);
    const result = await agentDeployerService.uninstallAgent(sshClient, hostCacheKey);
    res.json({
      success: true,
      message: '已停止目标机托管守护进程并清理相关目录',
      data: result,
    });
  } catch (err: any) {
    console.error(`[RemoteAgentController] 卸载主机 ${connectionId} 托管代理失败:`, err?.message || err);
    res.status(502).json({
      success: false,
      message: `卸载目标机代理失败: ${err?.message || err}`,
    });
  } finally {
    try { sshClient?.end(); } catch {}
  }
}
