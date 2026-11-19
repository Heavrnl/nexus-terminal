import { Client } from 'ssh2';
import { WebSocket } from 'ws';
import { ClientState } from '../websocket';
import { settingsService } from '../settings/settings.service';
import { MemUsage, parseFreeOutput, parseProcMeminfo } from './status-monitor-memory';
import {
    COMBINED_DYNAMIC_STATUS_CMD,
    COMBINED_STATIC_HOST_INFO_CMD,
    parseDynamicStatusSections,
    parseProcLoadavg,
    parseProcNetDevText,
    parseRootDiskUsage,
    parseStaticHostInfoOutput,
    type StaticHostInfo,
} from './status-monitor-parser';

/** 单条状态采集 SSH exec 命令超时（毫秒），防止弱网/挂死导致通道与 Promise 泄漏 */
const SSH_EXEC_TIMEOUT_MS = 8000;


interface ServerStatus {
    cpuPercent?: number;
    memPercent?: number;
    memUsed?: number; // MB
    memTotal?: number; // MB
    swapPercent?: number;
    swapUsed?: number; // MB
    swapTotal?: number; // MB
    diskPercent?: number;
    diskUsed?: number; // KB
    diskTotal?: number; // KB
    cpuModel?: string;
    netRxRate?: number; // Bytes per second
    netTxRate?: number; // Bytes per second
    netInterface?: string;
    osName?: string;
    loadAvg?: number[]; // 系统平均负载 [1min, 5min, 15min]
    timestamp: number; // 状态获取时间戳
}


interface NetworkStats {
    [interfaceName: string]: {
        rx_bytes: number;
        tx_bytes: number;
    }
}


// 用于存储上一次的网络统计信息以计算速率
const previousNetStats = new Map<string, { rx: number, tx: number, timestamp: number }>();

export class StatusMonitorService {
    private clientStates: Map<string, ClientState>; // 使用导入的 ClientState
    // 用于存储上一次的 CPU 统计信息以计算使用率
    private previousCpuStats = new Map<string, { total: number, idle: number, timestamp: number }>();
    // 会话级静态主机信息缓存（OS 名称 / CPU 型号 / 默认网卡）：单会话生命周期只探测一次
    private staticHostInfoCache = new Map<string, StaticHostInfo>();
    // 记录正在运行轮询的会话及防重入标志，避免弱网下 setInterval 叠加打爆 SSH MaxSessions
    private activePollingSessions = new Set<string>();
    private inFlightSessions = new Set<string>();

    constructor(clientStates: Map<string, ClientState>) {
        this.clientStates = clientStates;
    }

    /**
     * 启动指定会话的状态轮询（递归 setTimeout + 防重入）
     * @param sessionId 会话 ID
     */
    async startStatusPolling(sessionId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            return;
        }
        if (state.statusIntervalId || this.activePollingSessions.has(sessionId)) {
             return;
         }

         let intervalMs: number;
         try {
             const intervalSeconds = await settingsService.getStatusMonitorIntervalSeconds();
             intervalMs = Math.max(1000, intervalSeconds * 1000);
             console.log(`[StatusMonitor ${sessionId}] 使用配置的轮询间隔: ${intervalSeconds} 秒 (${intervalMs}ms)`);
         } catch (error) {
             console.error(`[StatusMonitor ${sessionId}] 获取轮询间隔设置失败，将使用默认值 3000ms:`, error);
             intervalMs = 3000; // 出错时回退到 3 秒
         }

         // 异步读配置后再次核对会话是否仍有效
         const freshState = this.clientStates.get(sessionId);
         if (!freshState || !freshState.sshClient || freshState.statusIntervalId) {
             return;
         }

         this.activePollingSessions.add(sessionId);

         const scheduleNext = () => {
             if (!this.activePollingSessions.has(sessionId)) return;
             const cur = this.clientStates.get(sessionId);
             if (!cur || !cur.sshClient || cur.ws.readyState !== WebSocket.OPEN) {
                 this.stopStatusPolling(sessionId);
                 return;
             }
             const timer = setTimeout(async () => {
                 if (!this.activePollingSessions.has(sessionId)) return;
                 await this.fetchAndSendServerStatus(sessionId);
                 scheduleNext();
             }, intervalMs);
             timer.unref?.();
             cur.statusIntervalId = timer;
         };

         scheduleNext();
    }

    /**
     * 停止指定会话的状态轮询并释放全部会话级缓存
     * @param sessionId 会话 ID
     */
    stopStatusPolling(sessionId: string): void {
        this.activePollingSessions.delete(sessionId);
        this.inFlightSessions.delete(sessionId);
        const state = this.clientStates.get(sessionId);
        if (state?.statusIntervalId) {
            clearTimeout(state.statusIntervalId);
            state.statusIntervalId = undefined;
        }
        previousNetStats.delete(sessionId);
        this.previousCpuStats.delete(sessionId);
        this.staticHostInfoCache.delete(sessionId);
    }

    /**
     * 获取并发送服务器状态给客户端（带防重入锁）
     * @param sessionId 会话 ID
     */
    private async fetchAndSendServerStatus(sessionId: string): Promise<void> {
        if (this.inFlightSessions.has(sessionId)) return;
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient || state.ws.readyState !== WebSocket.OPEN) {
            this.stopStatusPolling(sessionId);
            return;
        }
        this.inFlightSessions.add(sessionId);
        try {
            const status = await this.fetchServerStatus(state.sshClient, sessionId);
            if (state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'status_update', payload: { connectionId: state.dbConnectionId, status } }));
            }
        } catch (error: any) {
            if (state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'status_error', payload: { connectionId: state.dbConnectionId, message: `获取状态失败: ${error.message}` } }));
            }
        } finally {
            this.inFlightSessions.delete(sessionId);
        }
    }

     /**
      * 通过 SSH 复合命令高效获取服务器状态信息：
      *   - 静态主机信息（OS / CPU 型号 / 默认网卡）单会话仅采样一次并缓存；
      *   - 动态指标（Mem / CPU / LoadAvg / Net / Disk）每轮合并为单次 SSH exec。
      */
     private async fetchServerStatus(sshClient: Client, sessionId: string): Promise<ServerStatus> {
         const timestamp = Date.now();
         const status: Partial<ServerStatus> = { timestamp };

         try {
             // 1. 静态主机信息：每会话仅执行 1 次并缓存
             let staticInfo = this.staticHostInfoCache.get(sessionId);
             if (!staticInfo) {
                 try {
                     const staticOut = await this.executeSshCommand(sshClient, COMBINED_STATIC_HOST_INFO_CMD);
                     staticInfo = parseStaticHostInfoOutput(staticOut);
                 } catch {
                     staticInfo = {};
                 }
                 this.staticHostInfoCache.set(sessionId, staticInfo);
             }
             if (staticInfo.osName) status.osName = staticInfo.osName;
             status.cpuModel = staticInfo.cpuModel || 'Unknown';

             // 2. 动态指标：单次 SSH exec 拿齐全部 5 项动态数据
             let sections = { meminfo: '', stat: '', loadavg: '', netdev: '', df: '' };
             try {
                 const dynOut = await this.executeSshCommand(sshClient, COMBINED_DYNAMIC_STATUS_CMD);
                 sections = parseDynamicStatusSections(dynOut);
             } catch {
                 // 复合命令失败时各项走下方安全兜底
             }

             // 2.1 内存与 Swap（优先解析 /proc/meminfo，非 Linux 时回退到 free）
             try {
                 const mem = (sections.meminfo ? parseProcMeminfo(sections.meminfo) : null) ?? (await this.readMemFromFree(sshClient));
                 if (mem) {
                     status.memTotal = mem.memTotal;
                     status.memUsed = mem.memUsed;
                     status.memPercent = mem.memTotal > 0 ? parseFloat(((mem.memUsed / mem.memTotal) * 100).toFixed(1)) : 0;
                     status.swapTotal = mem.swapTotal;
                     status.swapUsed = mem.swapUsed;
                     status.swapPercent = mem.swapTotal > 0 ? parseFloat(((mem.swapUsed / mem.swapTotal) * 100).toFixed(1)) : 0;
                 }
             } catch { /* 静默处理 */ }

             // 2.2 根分区磁盘使用率
             if (sections.df) {
                 const disk = parseRootDiskUsage(sections.df);
                 if (disk) {
                     status.diskTotal = disk.diskTotal;
                     status.diskUsed = disk.diskUsed;
                     status.diskPercent = disk.diskPercent;
                 }
             }

             // 2.3 CPU 使用率（解析 head -n 1 /proc/stat）
             if (sections.stat) {
                 const currentCpuTimes = this.parseProcStat(sections.stat);
                 const now = Date.now();
                 if (currentCpuTimes) {
                     const prevCpuStats = this.previousCpuStats.get(sessionId);
                     if (prevCpuStats && prevCpuStats.timestamp < now) {
                         const totalDiff = currentCpuTimes.total - prevCpuStats.total;
                         const idleDiff = currentCpuTimes.idle - prevCpuStats.idle;
                         const timeDiffMs = now - prevCpuStats.timestamp;
                         if (totalDiff > 0 && timeDiffMs > 100) {
                             const usageRatio = 1.0 - (idleDiff / totalDiff);
                             status.cpuPercent = parseFloat((Math.max(0, Math.min(100, usageRatio * 100))).toFixed(1));
                         } else {
                             status.cpuPercent = prevCpuStats.total > 0 ? status.cpuPercent : 0;
                         }
                     } else {
                         status.cpuPercent = 0;
                     }
                     this.previousCpuStats.set(sessionId, { ...currentCpuTimes, timestamp: now });
                 }
             }

             // 2.4 系统平均负载（优先直接解析 /proc/loadavg，缺失时才回退 uptime）
             const loadAvg = parseProcLoadavg(sections.loadavg);
             if (loadAvg) {
                 status.loadAvg = loadAvg;
             } else {
                 try {
                     const uptimeOutput = await this.executeSshCommand(sshClient, 'LC_ALL=C uptime');
                     const match = uptimeOutput.match(/load average(?:s)?:\s*([\d.]+)[, ]?\s*([\d.]+)[, ]?\s*([\d.]+)/);
                     if (match) status.loadAvg = [parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])];
                 } catch { /* 静默处理 */ }
             }

             // 2.5 网络吞吐速率（直接解析 /proc/net/dev + 复用已缓存的默认网卡）
             if (sections.netdev) {
                 const currentStats = parseProcNetDevText(sections.netdev);
                 if (currentStats) {
                     let defaultInterface = staticInfo.defaultInterface;
                     if (!defaultInterface || !currentStats[defaultInterface]) {
                         defaultInterface = Object.keys(currentStats).find(iface => iface !== 'lo');
                         if (defaultInterface) {
                             staticInfo.defaultInterface = defaultInterface;
                         }
                     }

                     if (defaultInterface && currentStats[defaultInterface]) {
                         status.netInterface = defaultInterface;
                         const currentRx = currentStats[defaultInterface].rx_bytes;
                         const currentTx = currentStats[defaultInterface].tx_bytes;
                         const prevStats = previousNetStats.get(sessionId);

                         if (prevStats && prevStats.timestamp < timestamp) {
                             const timeDiffSeconds = (timestamp - prevStats.timestamp) / 1000;
                             if (timeDiffSeconds > 0.1) {
                                 status.netRxRate = Math.max(0, Math.round((currentRx - prevStats.rx) / timeDiffSeconds));
                                 status.netTxRate = Math.max(0, Math.round((currentTx - prevStats.tx) / timeDiffSeconds));
                             } else {
                                 status.netRxRate = 0;
                                 status.netTxRate = 0;
                             }
                         } else {
                             status.netRxRate = 0;
                             status.netTxRate = 0;
                         }

                         previousNetStats.set(sessionId, { rx: currentRx, tx: currentTx, timestamp });
                     }
                 }
             }
         } catch (error) {
             console.error(`[StatusMonitor ${sessionId}] General error fetching server status:`, error);
         }

         return status as ServerStatus;
     }

    /**
     * 从 /proc/meminfo 读取内存/交换信息。
     * key 由内核按英文常量导出，`cat` 也不经过 gettext，所以不受 LANG / LC_* 影响。
     * @returns 解析成功返回 MB 为单位的数据；文件不存在（非 Linux）或解析失败返回 null
     */
    private async readMemFromProc(sshClient: Client): Promise<MemUsage | null> {
        try {
            const output = await this.executeSshCommand(sshClient, 'cat /proc/meminfo');
            return parseProcMeminfo(output);
        } catch (err) {
            return null;
        }
    }

    /**
     * 退路：用 `free` 取内存/交换信息。
     * ⚠️ 必须前置 `LC_ALL=C`：procps 4.0+ 的 `free` 标签会随 locale 翻译
     * （中文下 `Mem:` 变成 `内存：`），匹配不到就会整块内存信息为 undefined。
     * @returns 解析成功返回 MB 为单位的数据；命令失败或解析失败返回 null
     */
    private async readMemFromFree(sshClient: Client): Promise<MemUsage | null> {
        let freeCommand = 'LC_ALL=C free -m';
        let isBusyBox = false;
        try {
            const busyboxCheck = await this.executeSshCommand(sshClient, 'busybox --help');
            if (busyboxCheck.includes('BusyBox')) {
                freeCommand = 'LC_ALL=C free'; // BusyBox 的 free 没有 -m，输出单位是 Byte
                isBusyBox = true;
            }
        } catch (err) {
            // 没有 busybox，沿用 free -m
        }
        try {
            const freeOutput = await this.executeSshCommand(sshClient, freeCommand);
            return parseFreeOutput(freeOutput, isBusyBox);
        } catch (err) {
            return null;
        }
    }

    /**
     * 解析 /proc/net/dev 的输出
     * @param sshClient SSH 客户端实例
     * @returns Promise<NetworkStats | null> 解析后的网络统计信息或 null
     */
    private async parseProcNetDev(sshClient: Client): Promise<NetworkStats | null> {
        let output: string;
        try {
            // 将命令执行放入 try...catch
            output = await this.executeSshCommand(sshClient, 'cat /proc/net/dev');
        } catch (error) {
            // 如果命令失败，记录警告并返回 null

            return null;
        }
        // 如果命令成功，继续解析
        try {
            const lines = output.split('\n').slice(2); // Skip header lines
            const stats: NetworkStats = {};
            for (const line of lines) {
                const parts = line.trim().split(/:\s+|\s+/);
                if (parts.length < 17) continue;
                const interfaceName = parts[0];
                const rx_bytes = parseInt(parts[1], 10);
                const tx_bytes = parseInt(parts[9], 10);
                if (!isNaN(rx_bytes) && !isNaN(tx_bytes)) {
                    stats[interfaceName] = { rx_bytes, tx_bytes };
                }
            }
            return Object.keys(stats).length > 0 ? stats : null;
        } catch (parseError) {
            return null;
        }
    }

    /**
     * 获取默认网络接口名称 (Linux specific)
     * @param sshClient SSH 客户端实例
     * @returns Promise<string | null> 默认接口名称或 null
     */
    private async getDefaultInterface(sshClient: Client): Promise<string | null> {
        try {
            // 使用 ip route 命令查找默认路由对应的接口
            const output = await this.executeSshCommand(sshClient, "ip route get 1.1.1.1 | grep -oP 'dev\\s+\\K\\S+'");
            const interfaceName = output.trim();
            if (interfaceName) return interfaceName;
            // 如果 ip route 没返回有效接口名，也尝试 fallback


        } catch (error) {

        try {
             const netDevOutput = await this.executeSshCommand(sshClient, 'cat /proc/net/dev');
             const lines = netDevOutput.split('\n').slice(2);
             for (const line of lines) {
                     const iface = line.trim().split(':')[0];
                     if (iface && iface !== 'lo') {
                         return iface;
                     }
                 }
            } catch (fallbackError) {

            }

            return null;
        }

        return null;
    }

    /**
     * 在 SSH 连接上执行单个命令（带超时保护，防止弱网或远端进程卡死导致通道泄漏）
     */
    private executeSshCommand(sshClient: Client, command: string, timeoutMs: number = SSH_EXEC_TIMEOUT_MS): Promise<string> {
        return new Promise((resolve, reject) => {
            let output = '';
            let settled = false;
            let activeStream: any = null;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { activeStream?.close?.(); } catch {}
                try { activeStream?.destroy?.(); } catch {}
                reject(new Error(`执行命令超时 (${timeoutMs}ms)`));
            }, timeoutMs);
            timer.unref?.();

            sshClient.exec(command, (err, stream) => {
                if (settled) {
                    try { stream?.close?.(); } catch {}
                    return;
                }
                if (err) {
                    settled = true;
                    clearTimeout(timer);
                    return reject(new Error(`执行命令 '${command}' 失败: ${err.message}`));
                }
                activeStream = stream;
                stream.on('close', () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(output.trim());
                }).on('error', (execErr: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reject(execErr);
                }).on('data', (data: Buffer) => {
                    output += data.toString('utf8');
                }).stderr.on('data', () => {
                });
            });
        });
    }

     /**
      * 查找与给定 SSH 客户端关联的会话 ID (辅助函数)
      * @param sshClientToFind 要查找的 SSH 客户端实例
      * @returns string | undefined 找到的会话 ID 或 undefined
      */
     private findSessionIdForClient(sshClientToFind: Client): string | undefined {
         for (const [sessionId, state] of this.clientStates.entries()) {
             if (state.sshClient === sshClientToFind) {
                 return sessionId;
             }
         }
         return undefined;
     }

    /**
     * Parses the output of /proc/stat to get total and idle CPU times.
     * @param output The string output from `cat /proc/stat`.
     * @returns An object with total and idle times, or null if parsing fails.
     */
    private parseProcStat(output: string): { total: number, idle: number } | null {
        try {
            const lines = output.split('\n');
            // Find the line starting with "cpu " (aggregate of all cores)
            const cpuLine = lines.find(line => line.startsWith('cpu '));
            if (!cpuLine) {
                // console.warn("Could not find 'cpu ' line in /proc/stat");
                return null;
            }

            // Fields documented in `man proc`: cpu user nice system idle iowait irq softirq steal guest guest_nice
            // We need to handle potential missing fields at the end (guest times are not always present)
            const fieldsStr = cpuLine.trim().split(/\s+/).slice(1); // Remove 'cpu' prefix
            const fields = fieldsStr.map(Number); // Convert remaining fields to numbers

            // We need at least the first 4 fields (user, nice, system, idle)
            if (fields.length < 4 || fields.slice(0, 4).some(isNaN)) {
                // console.warn("Invalid format or missing required fields in 'cpu ' line:", cpuLine);
                return null;
            }

            const idle = fields[3]; // The 4th field (index 3) is idle time

            // Total time is the sum of all fields. Filter out NaN values just in case.
            const total = fields.reduce((sum, value) => sum + (isNaN(value) ? 0 : value), 0);

            // Final check for NaN just to be safe
            if (isNaN(total) || isNaN(idle)) {
                // console.warn("NaN detected after parsing /proc/stat fields:", fields);
                return null;
            }

            return { total, idle };
        } catch (e) {
            // console.error("Error parsing /proc/stat:", e);
            return null;
        }
    }
}
