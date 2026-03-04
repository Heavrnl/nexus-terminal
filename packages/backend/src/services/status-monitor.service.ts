import { Client } from 'ssh2';
import { WebSocket } from 'ws';
import { ClientState } from '../websocket';
import { settingsService } from '../settings/settings.service';


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

    constructor(clientStates: Map<string, ClientState>) {
        this.clientStates = clientStates;
    }

    /**
     * 启动指定会话的状态轮询
     * @param sessionId 会话 ID
     */
    async startStatusPolling(sessionId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            return;
        }
        if (state.statusIntervalId) {
             return;
         }

         // +++ 从 settingsService 获取轮询间隔 +++
         let intervalMs: number;
         try {
             const intervalSeconds = await settingsService.getStatusMonitorIntervalSeconds();
             intervalMs = intervalSeconds * 1000;
             console.log(`[StatusMonitor ${sessionId}] 使用配置的轮询间隔: ${intervalSeconds} 秒 (${intervalMs}ms)`);
         } catch (error) {
             console.error(`[StatusMonitor ${sessionId}] 获取轮询间隔设置失败，将使用默认值 3000ms:`, error);
             intervalMs = 3000; // 出错时回退到 3 秒
         }

         // 移除立即执行，让 setInterval 负责第一次调用，给连接更多准备时间
         state.statusIntervalId = setInterval(() => {
             this.fetchAndSendServerStatus(sessionId);
         }, intervalMs); // --- 使用获取到的间隔 ---
    }

    /**
     * 停止指定会话的状态轮询
     * @param sessionId 会话 ID
     */
    stopStatusPolling(sessionId: string): void {
        const state = this.clientStates.get(sessionId);
        if (state?.statusIntervalId) {
            //console.warn(`[StatusMonitor] 停止会话 ${sessionId} 的状态轮询。`);
            clearInterval(state.statusIntervalId);
            state.statusIntervalId = undefined;
            previousNetStats.delete(sessionId); // 清理网络统计缓存
            this.previousCpuStats.delete(sessionId); // 清理 CPU 统计缓存
        }
    }

    /**
     * 获取并发送服务器状态给客户端
     * @param sessionId 会话 ID
     */
    private async fetchAndSendServerStatus(sessionId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient || state.ws.readyState !== WebSocket.OPEN) {
            //console.warn(`[StatusMonitor] 无法获取会话 ${sessionId} 的状态，停止轮询。原因：状态无效、SSH断开或WS关闭。`);
            this.stopStatusPolling(sessionId);
            return;
        }
        try {
            // 传递 sessionId 给 fetchServerStatus 以便查找 previousNetStats
            const status = await this.fetchServerStatus(state.sshClient, sessionId);
            state.ws.send(JSON.stringify({ type: 'status_update', payload: { connectionId: state.dbConnectionId, status } }));
        } catch (error: any) {
            // --- 移除 console.warn ---
            // console.warn(`[StatusMonitor] 获取会话 ${sessionId} 服务器状态失败:`, error);
            state.ws.send(JSON.stringify({ type: 'status_error', payload: { connectionId: state.dbConnectionId, message: `获取状态失败: ${error.message}` } }));
        }
    }

     /**
      * 通过 SSH 执行命令获取服务器状态信息
      * @param sshClient SSH 客户端实例
      * @param sessionId 当前会话 ID，用于网络速率计算
      * @returns Promise<ServerStatus> 服务器状态信息
      */
     private async fetchServerStatus(sshClient: Client, sessionId: string): Promise<ServerStatus> {
        //  console.debug(`[StatusMonitor ${sessionId}] Fetching server status...`);
         const timestamp = Date.now();
         let status: Partial<ServerStatus> = { timestamp };

         try {
             // --- OS Name ---
             try {
                 const osReleaseOutput = await this.executeSshCommand(sshClient, 'cat /etc/os-release');
                 const nameMatch = osReleaseOutput.match(/^PRETTY_NAME="?([^"]+)"?/m);
                 status.osName = nameMatch ? nameMatch[1] : (osReleaseOutput.match(/^NAME="?([^"]+)"?/m)?.[1] ?? 'Unknown');
             } catch (err) { }

             try {
                 let cpuModelOutput = '';
                 try {
                     cpuModelOutput = await this.executeSshCommand(sshClient, "cat /proc/cpuinfo | grep 'model name' | head -n 1");
                     status.cpuModel = cpuModelOutput.match(/model name\s*:\s*(.*)/i)?.[1].trim();
                 } catch (procErr) {

                     try {
                         cpuModelOutput = await this.executeSshCommand(sshClient, "lscpu | grep 'Model name:'");
                         status.cpuModel = cpuModelOutput.match(/Model name:\s+(.*)/)?.[1].trim();
                     } catch (lscpuErr) {

                     }
                 }
                 if (!status.cpuModel) {
                     status.cpuModel = 'Unknown';
                 }
             } catch (err) {

                 status.cpuModel = 'Unknown';
             }


             try {
                 let freeCommand = 'free -m';
                 let isBusyBox = false;
                 try {
                     const busyboxCheck = await this.executeSshCommand(sshClient, 'busybox --help');
                     if (busyboxCheck.includes('BusyBox')) {
                         freeCommand = 'free';
                         isBusyBox = true;
                     }
                 } catch (err) {
                     // 如果检查失败，默认使用 free -m
                 }
                 const freeOutput = await this.executeSshCommand(sshClient, freeCommand);
                 const lines = freeOutput.split('\n');
                 const memLine = lines.find(line => line.startsWith('Mem:'));
                 const swapLine = lines.find(line => line.startsWith('Swap:'));
                 if (memLine) {
                     const parts = memLine.split(/\s+/);
                     if (parts.length >= 3) {
                         let totalVal = parseInt(parts[1], 10);
                         let usedVal = parseInt(parts[2], 10);

                         if (isBusyBox) { 
                             if (!isNaN(totalVal)) totalVal = Math.round(totalVal / 1024);
                             if (!isNaN(usedVal)) usedVal = Math.round(usedVal / 1024);
                         }

                         if (!isNaN(totalVal) && !isNaN(usedVal)) {
                             status.memTotal = totalVal;
                             status.memUsed = usedVal;
                             status.memPercent = totalVal > 0 ? parseFloat(((usedVal / totalVal) * 100).toFixed(1)) : 0;
                         }
                     }
                 }
                 if (swapLine) {
                     const parts = swapLine.split(/\s+/);
                     if (parts.length >= 3) {
                         let totalVal = parseInt(parts[1], 10);
                         let usedVal = parseInt(parts[2], 10);

                         if (isBusyBox) {
                             if (!isNaN(totalVal)) totalVal = Math.round(totalVal / 1024);
                             if (!isNaN(usedVal)) usedVal = Math.round(usedVal / 1024);
                         }

                         if (!isNaN(totalVal) && !isNaN(usedVal)) {
                             status.swapTotal = totalVal;
                             status.swapUsed = usedVal;
                             status.swapPercent = totalVal > 0 ? parseFloat(((usedVal / totalVal) * 100).toFixed(1)) : 0;
                         }
                     }
                 } else {
                     status.swapTotal = 0;
                     status.swapUsed = 0;
                     status.swapPercent = 0;
                 }
             } catch (err) { /* 静默处理 */ }


             try {
                 let dfCommand = "df -kP /"; // 优先尝试 POSIX 标准格式
                 let dfOutput: string;
                 try {
                     dfOutput = await this.executeSshCommand(sshClient, dfCommand);
                 } catch (errP) {
                     dfCommand = "df -k /"; // 备用方案
                     try {
                        dfOutput = await this.executeSshCommand(sshClient, dfCommand);
                     } catch (errK) {
                        dfOutput = "";
                     }
                 }

                 if (dfOutput) {
                     const lines = dfOutput.split('\n');
                     let parsedDiskInfo = false;
                     // 从第二行开始查找根挂载点信息 (跳过表头)
                     for (let i = 1; i < lines.length; i++) {
                         const line = lines[i].trim();
                         // 确保是根挂载点，通常以 " /" 结尾
                         if (line.endsWith(" /")) {
                             const parts = line.split(/\s+/);
                             // 预期 parts 至少包含: 文件系统, 总量(KB), 已用(KB), 可用(KB), 百分比%, 挂载点
                             // 例如: /dev/sda1 10307920 3841884 5941800 40% /
                             if (parts.length >= 5) {
                                 const total = parseInt(parts[1], 10);
                                 const used = parseInt(parts[2], 10);
                                 const percentStr = parts.find(p => p.endsWith('%')); // 查找百分比字符串

                                 if (percentStr) {
                                     const percentMatch = percentStr.match(/(\d+)%/);
                                     if (!isNaN(total) && !isNaN(used) && percentMatch && percentMatch[1]) {
                                         status.diskTotal = total; // KB
                                         status.diskUsed = used;   // KB
                                         status.diskPercent = parseFloat(percentMatch[1]);
                                         parsedDiskInfo = true;
                                         break;
                                     }
                                 }
                             }
                         }
                     }

                 }
             } catch (err) {
                 // 如果捕获到错误 (例如 executeSshCommand 内部的 Promise reject), disk* 字段将保持 undefined
             }

            try {
                const procStatOutput = await this.executeSshCommand(sshClient, 'cat /proc/stat');
                const currentCpuTimes = this.parseProcStat(procStatOutput);
                const now = Date.now(); // Use a consistent timestamp

                if (currentCpuTimes) {
                    const prevCpuStats = this.previousCpuStats.get(sessionId);

                    if (prevCpuStats && prevCpuStats.timestamp < now) {
                        const totalDiff = currentCpuTimes.total - prevCpuStats.total;
                        const idleDiff = currentCpuTimes.idle - prevCpuStats.idle;
                        const timeDiffMs = now - prevCpuStats.timestamp; // Time difference in ms

                        // Ensure positive difference and minimal time gap (e.g., > 100ms) to avoid division by zero or erratic results
                        if (totalDiff > 0 && timeDiffMs > 100) {
                            const usageRatio = 1.0 - (idleDiff / totalDiff);
                            // Clamp value between 0 and 100, format to 1 decimal place
                            status.cpuPercent = parseFloat((Math.max(0, Math.min(100, usageRatio * 100))).toFixed(1));
                        } else {
                            // If totalDiff is not positive or time gap too small, report 0 or keep previous value?
                            // Reporting 0 might be misleading if the system is actually busy but no change was detected in the short interval.
                            // Let's keep the previous value if available, otherwise 0.
                            status.cpuPercent = prevCpuStats?.total > 0 ? status.cpuPercent : 0; // Keep existing status.cpuPercent if valid prev exists, else 0
                        }
                    } else {
                        // First run or timestamp issue, report 0 as we can't calculate a rate
                        status.cpuPercent = 0;
                    }
                    // Store current stats for the next iteration
                    this.previousCpuStats.set(sessionId, { ...currentCpuTimes, timestamp: now });
                } else {
                    // Failed to parse /proc/stat, set to undefined or keep previous? Let's use undefined.
                    status.cpuPercent = undefined;
                }
            } catch (err) {
                // Failed to execute cat /proc/stat
                status.cpuPercent = undefined;
                // console.warn(`[StatusMonitor ${sessionId}] Failed to get CPU stats via /proc/stat:`, err);
            }

            try {
                const uptimeOutput = await this.executeSshCommand(sshClient, 'uptime');
                 const match = uptimeOutput.match(/load average(?:s)?:\s*([\d.]+)[, ]?\s*([\d.]+)[, ]?\s*([\d.]+)/);
                 if (match) status.loadAvg = [parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])];
             } catch (err) { /* 静默处理 */ }


             try {
                 const currentStats = await this.parseProcNetDev(sshClient);
                 if (currentStats) {
                     const defaultInterface = await this.getDefaultInterface(sshClient) || Object.keys(currentStats).find(iface => iface !== 'lo'); // Detect or fallback excluding loopback

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
                             } else { status.netRxRate = 0; status.netTxRate = 0; }
                         } else { status.netRxRate = 0; status.netTxRate = 0; }

                         previousNetStats.set(sessionId, { rx: currentRx, tx: currentTx, timestamp });
                     } else { /* 静默处理 */ }
                 }
             } catch (err) { /* 静默处理 */ }

         } catch (error) {
             console.error(`[StatusMonitor ${sessionId}] General error fetching server status:`, error);
         }

         return status as ServerStatus;
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
     * 在 SSH 连接上执行单个命令
     * @param sshClient SSH 客户端实例
     * @param command 要执行的命令
     * @returns Promise<string> 命令的标准输出
     * @throws Error 如果命令执行失败
     */
    private executeSshCommand(sshClient: Client, command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            let output = '';
            sshClient.exec(command, {
	    	env: { LC_ALL: 'C' },
	    }, (err, stream) => {
                if (err) {
                    return reject(new Error(`执行命令 '${command}' 失败: ${err.message}`));
                }
                stream.on('close', (code: number, signal?: string) => {
                    resolve(output.trim());
                }).on('data', (data: Buffer) => {
                    output += data.toString('utf8');
                }).stderr.on('data', (data: Buffer) => {
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
