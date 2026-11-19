import { AuthenticatedWebSocket, ClientState, DockerContainer, DockerStats } from '../types';
import { parsePortsString } from '../utils';
import { clientStates, settingsService } from '../state';
import { buildDockerExecCommand, buildShellProbeCommand, parseShellProbeOutput } from '../../docker/exec-command';
import WebSocket from 'ws';

const DEFAULT_DOCKER_STATUS_INTERVAL_SECONDS = 2;
/** 单次 Docker SSH exec 超时（毫秒），防止远端 dockerd 挂起导致通道与内存泄漏 */
const DOCKER_EXEC_TIMEOUT_MS = 10000;

function execDockerSshCommand(state: ClientState, command: string, timeoutMs: number = DOCKER_EXEC_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        if (!state.sshClient) {
            return reject(new Error('SSH client disconnected before command execution.'));
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        let activeStream: any = null;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { activeStream?.close?.(); } catch {}
            try { activeStream?.destroy?.(); } catch {}
            reject(new Error(`Docker command timed out (${timeoutMs}ms)`));
        }, timeoutMs);
        timer.unref?.();

        state.sshClient.exec(command, { pty: false }, (err, stream) => {
            if (settled) {
                try { stream?.close?.(); } catch {}
                return;
            }
            if (err) {
                settled = true;
                clearTimeout(timer);
                return reject(err);
            }
            activeStream = stream;
            stream.on('data', (data: Buffer) => { stdout += data.toString(); });
            stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
            stream.on('close', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ stdout, stderr });
            });
            stream.on('error', (execErr: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(execErr);
            });
        });
    });
}

export async function fetchRemoteDockerStatus(state: ClientState): Promise<{ available: boolean; containers: DockerContainer[] }> {
    if (!state || !state.sshClient) {
        console.warn(`[fetchRemoteDockerStatus] SSH client not available or not connected for session ${state?.ws?.sessionId}.`);
        throw new Error('SSH client not available or not connected');
    }

    let allContainers: DockerContainer[] = [];
    const statsMap = new Map<string, DockerStats>();

    try {
        // 直接执行 docker ps 命令，单次 exec 完成可用性探测与容器数据拉取，极大降低 SSH 通道占用与竞争
        const psCommand = "docker ps -a --no-trunc --format '{{json .}}'";
        const { stdout: psStdout, stderr: psStderr } = await execDockerSshCommand(state, psCommand);

        const isExplicitlyUnavailable = 
            psStderr.includes('command not found') ||
            psStderr.includes('docker: not found') ||
            psStderr.includes('permission denied') ||
            psStderr.includes('Cannot connect to the Docker daemon') ||
            psStderr.includes('Is the docker daemon running');

        if (isExplicitlyUnavailable) {
            console.warn(`[fetchRemoteDockerStatus] Docker unavailable or inaccessible on session ${state.ws?.sessionId}. Stderr: ${psStderr.trim()}`);
            return { available: false, containers: [] };
        } else if (psStderr) {
            console.warn(`[fetchRemoteDockerStatus] Docker ps command stderr on session ${state.ws?.sessionId}: ${psStderr.trim()}`);
        }

        const lines = psStdout.trim() ? psStdout.trim().split('\n') : [];
        allContainers = lines
            .map(line => {
                try {
                    const data = JSON.parse(line);
                    const container: DockerContainer = {
                        id: data.ID,
                        Names: typeof data.Names === 'string' ? data.Names.split(',') : (data.Names || []),
                        Image: data.Image || '',
                        ImageID: data.ImageID || '',
                        Command: data.Command || '',
                        Created: data.CreatedAt || 0,
                        State: data.State || 'unknown',
                        Status: data.Status || '',
                        Ports: parsePortsString(data.Ports),
                        Labels: data.Labels || {},
                        stats: null
                    };
                    return container;
                } catch (parseError) {
                    console.error(`[fetchRemoteDockerStatus] Failed to parse container JSON line for session ${state.ws.sessionId}: ${line}`, parseError);
                    return null;
                }
            })
            .filter((container): container is DockerContainer => container !== null);
    } catch (error: any) {
        console.warn(`[fetchRemoteDockerStatus] Error executing docker ps for session ${state.ws?.sessionId}:`, error.message);
        // 如果是 SSH 通道占用或断开等基础设施瞬态错误，直接抛出，绝不向前端广播为 Docker 不可用
        throw error;
    }

    const runningContainerIds = allContainers.filter(c => c.State === 'running').map(c => c.id);

    if (runningContainerIds.length > 0) {
        try {
            const statsCommand = `docker stats ${runningContainerIds.join(' ')} --no-stream --format '{{json .}}'`;
            const { stdout: statsStdout, stderr: statsStderr } = await execDockerSshCommand(state, statsCommand);

            if (statsStderr) {
                console.warn(`[fetchRemoteDockerStatus] Docker stats command stderr on session ${state.ws.sessionId}: ${statsStderr.trim()}`);
            }

            const statsLines = statsStdout.trim() ? statsStdout.trim().split('\n') : [];
            statsLines.forEach(line => {
                try {
                    const statsData = JSON.parse(line) as DockerStats;
                    if (statsData.ID) {
                        statsMap.set(statsData.ID, statsData);
                    }
                } catch (parseError) {
                    console.error(`[fetchRemoteDockerStatus] Failed to parse stats JSON line for session ${state.ws.sessionId}: ${line}`, parseError);
                }
            });
        } catch (error: any) {
            console.warn(`[fetchRemoteDockerStatus] Error executing docker stats for session ${state.ws.sessionId}:`, error.message);
        }
    }

    allContainers.forEach(container => {
        const shortId = container.id.substring(0, 12);
        const stats = statsMap.get(container.id) || statsMap.get(shortId);
        if (stats) {
            container.stats = stats;
        }
    });

    return { available: true, containers: allContainers };
}

export async function handleDockerGetStatus(ws: AuthenticatedWebSocket, sessionId: string | undefined): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_status 请求，但无活动会话状态。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: 'Session state not found.' } }));
        return;
    }
    if (!state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_status 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: 'SSH connection not active.' } }));
        return;
    }
    try {
        const statusPayload = await fetchRemoteDockerStatus(state);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: statusPayload }));
    } catch (error: any) {
        console.error(`WebSocket: 手动执行远程 Docker 状态命令失败 for session ${sessionId}:`, error);
        const errorMessage = error.message || 'Unknown error fetching status';
        const isUnavailable = errorMessage.includes('command not found') || errorMessage.includes('Cannot connect to the Docker daemon');
        if (ws.readyState === WebSocket.OPEN) {
            if (isUnavailable) {
                ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: { available: false, containers: [] } }));
            } else {
                ws.send(JSON.stringify({ type: 'docker:status:error', sessionId, payload: { message: `Failed to get remote Docker status: ${errorMessage}` } }));
            }
        }
    }
}

export async function handleDockerCommand(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state || !state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:command 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command: payload?.command, message: 'SSH connection not active.' } }));
        return;
    }
    const { containerId, command } = payload || {};
    if (!containerId || typeof containerId !== 'string' || !command || !['start', 'stop', 'restart', 'remove'].includes(command)) {
        console.error(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的无效 docker:command 请求。Payload:`, payload);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command: command, message: 'Invalid containerId or command.' } }));
        return;
    }

    console.log(`WebSocket: Processing command '${command}' for container '${containerId}' on session ${sessionId}...`);
    try {
        const cleanContainerId = containerId.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!cleanContainerId) throw new Error('Invalid container ID format after sanitization.');

        let dockerCliCommand: string;
        switch (command) {
            case 'start': dockerCliCommand = `docker start ${cleanContainerId}`; break;
            case 'stop': dockerCliCommand = `docker stop ${cleanContainerId}`; break;
            case 'restart': dockerCliCommand = `docker restart ${cleanContainerId}`; break;
            case 'remove': dockerCliCommand = `docker rm -f ${cleanContainerId}`; break;
            default: throw new Error(`Unsupported command: ${command}`);
        }

        await new Promise<void>((resolve, reject) => {
            if (!state.sshClient) {
                return reject(new Error('SSH client disconnected before command execution.'));
            }
            state.sshClient.exec(dockerCliCommand, { pty: false }, (err, stream) => {
                if (err) return reject(err);
                let stderr = '';
                stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                stream.on('close', (code: number | null) => {
                    if (code === 0) {
                        console.log(`WebSocket: 远程 Docker 命令 (${dockerCliCommand}) on session ${sessionId} 执行成功。`);
                        resolve();
                    } else {
                        console.error(`WebSocket: 远程 Docker 命令 (${dockerCliCommand}) on session ${sessionId} 执行失败 (Code: ${code}). Stderr: ${stderr}`);
                        reject(new Error(`Command failed with code ${code}. ${stderr || 'No stderr output.'}`));
                    }
                });
                stream.on('error', (execErr: Error) => reject(execErr));
            });
        });

        // Request a status update after a short delay
        setTimeout(() => {
            const currentState = clientStates.get(sessionId!); // Re-fetch state as it might have changed
            if (currentState && currentState.ws.readyState === WebSocket.OPEN) {
                currentState.ws.send(JSON.stringify({ type: 'request_docker_status_update' }));
            }
        }, 500);

    } catch (error: any) {
        console.error(`WebSocket: 执行远程 Docker 命令 (${command} for ${containerId}) 失败 for session ${sessionId}:`, error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command, containerId, message: `Failed to execute remote command: ${error.message}` } }));
    }
}

export async function handleDockerGetStats(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state || !state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_stats 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId: payload?.containerId, message: 'SSH connection not active.' } }));
        return;
    }
    if (!payload || !payload.containerId) {
        console.warn(`WebSocket: Invalid payload for docker:get_stats in session ${sessionId}:`, payload);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId: payload?.containerId, message: 'Missing containerId.' } }));
        return;
    }

    const containerId = payload.containerId;
    console.log(`WebSocket: Handling docker:get_stats for container ${containerId} in session ${sessionId}`);
    const command = `docker stats ${containerId} --no-stream --format '{{json .}}'`;

    try {
        const execResult = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            if (!state.sshClient) {
                return reject(new Error('SSH client disconnected before command execution.'));
            }
            state.sshClient.exec(command, { pty: false }, (err, stream) => {
                if (err) return reject(err);
                stream.on('data', (data: Buffer) => { stdout += data.toString(); });
                stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                stream.on('close', () => resolve({ stdout, stderr }));
                stream.on('error', (execErr: Error) => reject(execErr));
            });
        });

        if (execResult.stderr) {
            console.error(`WebSocket: Docker stats stderr for ${containerId} in session ${sessionId}: ${execResult.stderr}`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: execResult.stderr.trim() || 'Error executing stats command.' } }));
            return;
        }

        if (!execResult.stdout) {
            console.warn(`WebSocket: No stats output for container ${containerId} in session ${sessionId}. Might be stopped or error occurred.`);
            if (!execResult.stderr && ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: 'No stats data received (container might be stopped).' } }));
            }
            return;
        }

        try {
            const statsData = JSON.parse(execResult.stdout.trim());
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:update', payload: { containerId, stats: statsData } }));
        } catch (parseError) {
            console.error(`WebSocket: Failed to parse docker stats JSON for ${containerId} in session ${sessionId}: ${execResult.stdout}`, parseError);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: 'Failed to parse stats data.' } }));
        }

    } catch (error: any) {
        console.error(`WebSocket: Failed to execute docker stats for ${containerId} in session ${sessionId}:`, error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: error.message || 'Failed to fetch Docker stats.' } }));
    }
}

/**
 * 探测容器里可用的交互式 shell（用于「进入容器」的默认命令）。
 *
 * 为什么要在后端探测：只用 `docker exec <id> bash` 是不够的 ——
 * Alpine/BusyBox 只有 ash/sh，Windows 容器只有 powershell/cmd，distroless 甚至没有 shell。
 * 一次 SSH exec 里把候选列表挨个试一遍，把结果回给前端缓存。
 */
export async function detectContainerShell(state: ClientState, containerId: string): Promise<{ shell: string; os: string }> {
    const cleanId = containerId.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!cleanId) throw new Error('Invalid container ID format after sanitization.');
    if (!state.sshClient) throw new Error('SSH client not available or not connected');

    const cached = state.dockerShellCache?.get(cleanId);
    if (cached) return { shell: cached, os: '' };

    const output = await new Promise<string>((resolve, reject) => {
        if (!state.sshClient) return reject(new Error('SSH client disconnected before command execution.'));
        let stdout = '';
        let settled = false;
        // docker daemon 无响应时不能把前端「进入容器」按死：8s 直接返回空结果
        const timer = setTimeout(() => { settled = true; resolve(stdout); }, 8000);
        state.sshClient.exec(buildShellProbeCommand(cleanId), { pty: false }, (err, stream) => {
            if (err) { clearTimeout(timer); return reject(err); }
            stream.on('data', (data: Buffer) => { stdout += data.toString(); });
            stream.stderr.on('data', () => { /* 探测期的报错本来就是预期噪音 */ });
            stream.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(stdout); } });
            stream.on('error', (execErr: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(execErr); } });
        });
    });

    const { shell, os } = parseShellProbeOutput(output);
    if (shell) {
        if (!state.dockerShellCache) state.dockerShellCache = new Map();
        state.dockerShellCache.set(cleanId, shell);
    }
    return { shell, os };
}

/**
 * 处理「进入容器」：探测容器里能用的 shell，回一条成品命令给前端。
 *
 * 为什么必须在后端：探测要走 SSH，前端拿不到远端 shell；
 * 探测结果按容器缓存在 `state.dockerShellCache`（同一容器的 shell 不会变）。
 *
 * 为什么没有「用户自己填」的入口：shell 是**容器级**属性，而连接是一台主机 ——
 * 主机上的 Alpine 与 Debian 容器要的 shell 不一样，挂一个连接级固定命令反而会错。
 */
export async function handleDockerGetExecCommand(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    const containerId = typeof payload?.containerId === 'string' ? payload.containerId : '';
    const requestId = payload?.requestId;

    const reply = (data: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'docker:exec_command', sessionId, payload: { containerId, requestId, ...data } }));
        }
    };

    if (!state || !state.sshClient) { reply({ error: 'SSH connection not active.' }); return; }
    const cleanId = containerId.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!cleanId) { reply({ error: 'Missing or invalid containerId.' }); return; }

    try {
        const { shell } = await detectContainerShell(state, cleanId);
        const command = buildDockerExecCommand(cleanId, shell);
        console.log(`[docker:get_exec_command] 会话 ${sessionId} 容器 ${cleanId} → ${command}${shell ? '' : '（未探到 shell，退回 sh）'}`);
        reply({ command, shell: shell || 'sh', detected: !!shell });
    } catch (error: any) {
        console.warn(`[docker:get_exec_command] 会话 ${sessionId} 容器 ${cleanId} 探测失败:`, error.message);
        // 探测失败也要能进容器：退回最保守的 sh
        reply({ command: buildDockerExecCommand(cleanId, 'sh'), shell: 'sh', detected: false, error: error.message });
    }
}

export async function startDockerStatusPolling(sessionId: string): Promise<void> {
    const state = clientStates.get(sessionId);
    if (!state) {
        console.warn(`[Docker Polling] Cannot start polling for non-existent session ${sessionId}`);
        return;
    }

    console.log(`WebSocket: 会话 ${sessionId} 正在启动 Docker 状态轮询...`);
    let dockerPollIntervalMs = DEFAULT_DOCKER_STATUS_INTERVAL_SECONDS * 1000;
    try {
        const intervalSetting = await settingsService.getSetting('dockerStatusIntervalSeconds');
        if (intervalSetting) {
            const intervalSeconds = parseInt(intervalSetting, 10);
            if (!isNaN(intervalSeconds) && intervalSeconds >= 1) {
                dockerPollIntervalMs = intervalSeconds * 1000;
                console.log(`[Docker Polling] Using interval from settings: ${intervalSeconds}s (${dockerPollIntervalMs}ms) for session ${sessionId}`);
            } else {
                 console.warn(`[Docker Polling] Invalid interval setting '${intervalSetting}' found. Using default ${dockerPollIntervalMs}ms for session ${sessionId}`);
            }
        } else {
            console.log(`[Docker Polling] No interval setting found. Using default ${dockerPollIntervalMs}ms for session ${sessionId}`);
        }
    } catch (settingError) {
         console.error(`[Docker Polling] Error fetching interval setting for session ${sessionId}. Using default ${dockerPollIntervalMs}ms:`, settingError);
    }

    // Clear existing timer if any, to prevent multiple pollers for the same session
    if (state.dockerStatusIntervalId) {
        clearTimeout(state.dockerStatusIntervalId);
        delete state.dockerStatusIntervalId;
        console.log(`[Docker Polling] Cleared existing Docker status timer for session ${sessionId}.`);
    }

    // 使用防重入递归 setTimeout：上一轮 docker ps / docker stats 结束后再排期下一轮，
    // 彻底杜绝弱网或 dockerd 卡顿时 SSH 通道叠加打爆 MaxSessions。
    let activeTimer: ReturnType<typeof setTimeout> | null = null;
    const isStillCurrent = (cur: ClientState | undefined): cur is ClientState =>
        !!cur && cur.ws.readyState === WebSocket.OPEN && !!cur.sshClient && cur.dockerStatusIntervalId === activeTimer;

    const runPollOnce = async (isInitial: boolean): Promise<boolean> => {
        const currentState = clientStates.get(sessionId);
        if (!currentState || currentState.ws.readyState !== WebSocket.OPEN || !currentState.sshClient) {
            if (currentState && activeTimer && currentState.dockerStatusIntervalId === activeTimer) {
                delete currentState.dockerStatusIntervalId;
            }
            return false;
        }
        try {
            const statusPayload = await fetchRemoteDockerStatus(currentState);
            if (currentState.ws.readyState === WebSocket.OPEN) {
                currentState.ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: statusPayload }));
            }
            // 若明确探测到远端无 Docker，自动熔断停止后续轮询节约资源
            if (!statusPayload.available) {
                console.log(`[Docker Polling] 远端主机无可用 Docker，停止周期轮询 (会话: ${sessionId})`);
                if (currentState.dockerStatusIntervalId === activeTimer) {
                    delete currentState.dockerStatusIntervalId;
                }
                return false;
            }
            return true;
        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error fetching status';
            const isUnavailable =
                errorMessage.includes('command not found') ||
                errorMessage.includes('Cannot connect to the Docker daemon') ||
                errorMessage.includes('not recognized');
            if (isInitial) {
                console.warn(`[Docker Initial Fetch] 首次获取 Docker 状态失败 for session ${sessionId}:`, errorMessage);
            } else {
                console.warn(`[Docker Polling] 探测 Docker 状态失败 (会话 ${sessionId}):`, errorMessage);
            }
            if (isUnavailable) {
                console.log(`[Docker Polling] 判定远程主机无可用 Docker 守护进程，自动熔断停止周期轮询 (会话: ${sessionId})`);
                if (currentState.dockerStatusIntervalId === activeTimer) {
                    delete currentState.dockerStatusIntervalId;
                }
                if (isInitial && currentState.ws.readyState === WebSocket.OPEN) {
                    currentState.ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: { available: false, containers: [] } }));
                }
                return false;
            }
            if (isInitial && currentState.ws.readyState === WebSocket.OPEN) {
                currentState.ws.send(JSON.stringify({ type: 'docker:status:error', sessionId, payload: { message: `Initial Docker status fetch failed: ${errorMessage}` } }));
            }
            return true;
        }
    };

    const scheduleNext = () => {
        const cur = clientStates.get(sessionId);
        if (!cur || cur.ws.readyState !== WebSocket.OPEN || !cur.sshClient) return;
        const timer = setTimeout(async () => {
            const st = clientStates.get(sessionId);
            if (!isStillCurrent(st)) return;
            const shouldContinue = await runPollOnce(false);
            if (shouldContinue && isStillCurrent(clientStates.get(sessionId))) {
                scheduleNext();
            }
        }, dockerPollIntervalMs);
        timer.unref?.();
        activeTimer = timer;
        cur.dockerStatusIntervalId = timer;
    };

    // 先执行首次探测，再根据结果决定是否开启周期轮询（无 Docker 主机零后续定时器）
    const shouldContinueAfterInitial = await runPollOnce(true);
    if (shouldContinueAfterInitial) {
        const curAfter = clientStates.get(sessionId);
        if (curAfter && curAfter.ws.readyState === WebSocket.OPEN && curAfter.sshClient && !curAfter.dockerStatusIntervalId) {
            scheduleNext();
        }
    }
}