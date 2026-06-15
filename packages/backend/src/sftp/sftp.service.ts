import { Client, SFTPWrapper, Stats, WriteStream } from 'ssh2';
import { WebSocket } from 'ws';
import { ClientState, AuthenticatedWebSocket } from '../websocket/types';
import * as pathModule from 'path'; 
import * as jschardet from 'jschardet'; 
import * as iconv from 'iconv-lite';
// +++ 导入新类型 +++
import {
    SftpCompressRequestPayload,
    SftpCompressSuccessPayload,
    SftpCompressErrorPayload,
    SftpDecompressRequestPayload,
    SftpDecompressSuccessPayload,
    SftpDecompressErrorPayload
} from '../websocket/types';

// +++ Define local interface for readdir results +++
interface SftpDirEntry {
    filename: string;
    longname: string;
    attrs: Stats;
}

// 定义服务器状态的数据结构 (与前端 StatusMonitor.vue 匹配)
// Note: This interface seems out of place here, but keeping it for now as it was in the original file.
// Ideally, it should be in a shared types file.
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

// Interface for parsed network stats - Also seems out of place here.
interface NetworkStats {
    [interfaceName: string]: {
        rx_bytes: number;
        tx_bytes: number;
    }
}

// Note: These constants seem related to StatusMonitorService, not SftpService.
const DEFAULT_POLLING_INTERVAL = 1000;
const previousNetStats = new Map<string, { rx: number, tx: number, timestamp: number }>();

// Interface for tracking active uploads
interface ActiveUpload {
    remotePath: string;
    totalSize: number;
    bytesWritten: number;
    stream: WriteStream;
    sessionId: string; // Link back to the session for cleanup
    relativePath?: string;
    drainPromise?: Promise<void> | null; // +++ For managing drain event listeners +++
    inFlightChunks: number;                 // 滑动窗口：已接收但尚未写入完成的块数量
    pendingChunks: Map<number, Buffer>;     // 乱序到达的待写入块缓冲区
    expectedChunkIndex: number;             // 下一个期望写入的块索引
    flushLock: Promise<void> | null;        // 刷写锁，保证按序写入不重入
    closeTimeoutFallback: ReturnType<typeof setTimeout> | null; // stream.end 后等待 close 的兜底定时器
    endRequested: boolean;                  // 标记 stream.end() 是否已调用
}
// +++ 滑动窗口大小：允许同时在途的最大块数量 +++
const UPLOAD_WINDOW_SIZE = 8;
// +++ 全局缓冲内存上限（256MB），防止并发上传耗尽内存 +++
const GLOBAL_UPLOAD_MEMORY_LIMIT = 256 * 1024 * 1024;
// +++ 当前所有活跃上传已缓冲内存总量 +++
let globalBufferedBytes = 0;
export class SftpService {
    private clientStates: Map<string, ClientState>; // 使用导入的 ClientState
    private activeUploads: Map<string, ActiveUpload>; // Map<uploadId, ActiveUpload>

    constructor(clientStates: Map<string, ClientState>) {
        this.clientStates = clientStates;
        this.activeUploads = new Map(); // Initialize the map
    }

    /**
     * 初始化 SFTP 会话
     * @param sessionId 会话 ID
     */
    async initializeSftpSession(sessionId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient || state.sftp) {
            console.warn(`[SFTP] 无法为会话 ${sessionId} 初始化 SFTP：状态无效、SSH客户端不存在或 SFTP 已初始化。`);
            return;
        }
        // +++ 如果开启了 SFTP sudo 提权，走 sudo 模式初始化 +++
        if (state.sftp_sudo_enabled) {
            try {
                console.log(`[SFTP] 会话 ${sessionId} 检测到 sudo 提权已开启，使用 sudo 模式初始化 SFTP...`);
                const sftpInstance = await this.connectSudoSftp(
                    state.sshClient,
                    state.sftp_sudo_password ?? ''
                );
                state.sftp = sftpInstance;
                state.ws.send(JSON.stringify({ type: 'sftp_ready', payload: { connectionId: state.dbConnectionId } }));
                console.log(`[SFTP] 会话 ${sessionId} sudo 模式 SFTP 初始化成功。`);
                sftpInstance.on('end', () => {
                    console.log(`[SFTP] 会话 ${sessionId} 的 sudo SFTP 会话已结束。`);
                    if (state) state.sftp = undefined;
                });
                sftpInstance.on('close', () => {
                    console.log(`[SFTP] 会话 ${sessionId} 的 sudo SFTP 会话已关闭。`);
                    if (state) state.sftp = undefined;
                });
                sftpInstance.on('error', (sftpErr: Error) => {
                    console.error(`[SFTP] 会话 ${sessionId} 的 sudo SFTP 会话出错:`, sftpErr);
                    if (state) state.sftp = undefined;
                    state?.ws.send(JSON.stringify({ type: 'sftp_error', payload: { connectionId: state.dbConnectionId, message: 'SFTP 会话错误' } }));
                });
                return;
            } catch (sudoErr: any) {
                console.error(`[SFTP] 会话 ${sessionId} sudo 模式 SFTP 初始化失败:`, sudoErr);
                state.ws.send(JSON.stringify({ type: 'sftp_error', payload: { connectionId: state.dbConnectionId, message: `SFTP sudo 初始化失败: ${sudoErr.message}` } }));
                return;
            }
        }
        if (!state.sshClient) {
             console.error(`[SFTP] 会话 ${sessionId} 的 SSH 客户端不存在，无法初始化 SFTP。`);
             return;
        }
        return new Promise((resolve, reject) => {
            state.sshClient.sftp((err, sftpInstance) => {
                if (err) {
                    console.error(`[SFTP] 为会话 ${sessionId} 初始化 SFTP 会话失败:`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp_error', payload: { connectionId: state.dbConnectionId, message: 'SFTP 初始化失败' } }));
                    reject(err);
                } else {
                    console.log(`[SFTP] 为会话 ${sessionId} 初始化 SFTP 会话成功。`);
                    state.sftp = sftpInstance;
                    state.ws.send(JSON.stringify({ type: 'sftp_ready', payload: { connectionId: state.dbConnectionId } }));
                    sftpInstance.on('end', () => {
                        console.log(`[SFTP] 会话 ${sessionId} 的 SFTP 会话已结束。`);
                        if (state) state.sftp = undefined;
                    });
                    sftpInstance.on('close', () => {
                        console.log(`[SFTP] 会话 ${sessionId} 的 SFTP 会话已关闭。`);
                         if (state) state.sftp = undefined;
                    });
                    sftpInstance.on('error', (sftpErr: Error) => {
                         console.error(`[SFTP] 会话 ${sessionId} 的 SFTP 会话出错:`, sftpErr);
                         if (state) state.sftp = undefined;
                         state?.ws.send(JSON.stringify({ type: 'sftp_error', payload: { connectionId: state.dbConnectionId, message: 'SFTP 会话错误' } }));
                    });
                    resolve();
                }
            });
        });
    }

    /**
     * 清理 SFTP 会话
     * @param sessionId 会话 ID
     */
    cleanupSftpSession(sessionId: string): void {
        const state = this.clientStates.get(sessionId);
        if (state?.sftp) {
            console.log(`[SFTP] 正在清理 ${sessionId} 的 SFTP 会话...`);
            state.sftp.end();
            state.sftp = undefined;
        }
        // Also clean up any active uploads associated with this session
        this.activeUploads.forEach((upload, uploadId) => {
            if (upload.sessionId === sessionId) {
                console.warn(`[SFTP] Cleaning up active upload ${uploadId} for session ${sessionId} due to SFTP session cleanup.`);
                this.cancelUploadInternal(uploadId, 'SFTP session ended'); // Internal cancel without sending message
            }
        });
    }
    /**
     * 使用 sudo 提权方式建立 SFTP 连接。
     * 通过 exec 执行 `sudo -S sftp-server`，再手动构造 SFTP 协议封装，
     * 使 SFTP 会话以 root 身份运行，从而可以访问 /root 等受限目录。
     */
    private connectSudoSftp(client: Client, password: string): Promise<SFTPWrapper> {
        // 从 ssh2 内部加载 SFTP 协议类（不是公开导出，需要从内部路径引入）
        const { SFTP } = require('ssh2/lib/protocol/SFTP.js');
        if (!SFTP) {
            return Promise.reject(new Error('当前环境不支持 SFTP sudo 模式（无法加载 SFTP 协议类）。'));
        }
        // 常见的 sftp-server 路径
        const sftpPaths = [
            '/usr/lib/openssh/sftp-server',
            '/usr/libexec/openssh/sftp-server',
            '/usr/lib/ssh/sftp-server',
            '/usr/libexec/sftp-server',
            '/usr/local/libexec/sftp-server',
            '/usr/local/lib/sftp-server',
        ];
        const probeServerPath = async (): Promise<string> => {
            for (const p of sftpPaths) {
                try {
                    await new Promise<void>((resolve, reject) => {
                        client.exec(`test -x ${p}`, (err, stream) => {
                            if (err) return reject(err);
                            stream.on('exit', (code: number) => {
                                if (code === 0) resolve();
                                else reject(new Error('Not found'));
                            });
                            stream.resume();
                            stream.stderr.resume();
                        });
                    });
                    return p;
                } catch {
                    // 继续探测下一个路径
                }
            }
            console.warn('[SFTP] 未能探测到 sftp-server，使用默认路径 /usr/lib/openssh/sftp-server');
            return '/usr/lib/openssh/sftp-server';
        };
        return new Promise<SFTPWrapper>(async (resolve, reject) => {
            let serverPath: string;
            try {
                serverPath = await probeServerPath();
            } catch (e: any) {
                return reject(e);
            }
            console.log(`[SFTP] sudo 模式使用 sftp-server: ${serverPath}`);
            const prompt = 'SUDOPASSWORD:';
            const readyMarker = 'SFTPREADY';
            const readyMarkerBuffer = Buffer.from(readyMarker);
            // 用 printf 打印同步标记，再 exec sftp-server；-S 从 stdin 读密码，自定义 prompt 便于检测
            const cmd = `sudo -S -p '${prompt}' sh -c 'printf ${readyMarker}; exec ${serverPath} -e'`;
            console.log(`[SFTP] 执行 sudo 命令: ${cmd}`);
            // 关闭 pty，保证 SFTP 二进制流干净
            client.exec(cmd, { pty: false }, (err, stream) => {
                if (err) return reject(err);
                let sftpInitialized = false;
                let sftp: any = null;
                let settled = false;
                let stdoutBuffer = Buffer.alloc(0);
                let stderrBuffer = '';
                let pendingAfterMarker: Buffer | null = null;
                let sftpCreated = false;
                const timeoutMs = 20000;
                const timeoutId = setTimeout(() => {
                    if (sftpInitialized || settled) return;
                    settled = true;
                    stream.stderr?.removeListener('data', onStderr);
                    stream.removeListener('data', onStdout);
                    reject(new Error('SFTP sudo 握手超时。可能原因：(1) 密码错误，(2) sudo 需要 TTY，(3) 用户没有 sudo 权限。'));
                }, timeoutMs);
                const finalize = (error: Error | null, result?: any) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeoutId);
                    stream.stderr?.removeListener('data', onStderr);
                    stream.removeListener('data', onStdout);
                    if (error) reject(error);
                    else resolve(result);
                };
                const createSftp = () => {
                    if (sftpCreated) return;
                    sftpCreated = true;
                    try {
                        const chanInfo = {
                            type: 'sftp',
                            incoming: (stream as any).incoming,
                            outgoing: (stream as any).outgoing,
                        };
                        sftp = new SFTP(client, chanInfo, {});
                        // 把后续通道数据直接交给 SFTP 解析器
                        if ((client as any)._chanMgr && typeof (stream as any).incoming?.id === 'number') {
                            (client as any)._chanMgr.update((stream as any).incoming.id, sftp);
                        }
                        sftp.on('ready', () => {
                            sftpInitialized = true;
                            console.log('[SFTP] sudo 模式 SFTP 协议就绪。');
                            finalize(null, sftp);
                        });
                        sftp.on('error', (e: Error) => {
                            console.error('[SFTP] sudo 模式 SFTP 协议错误:', e.message);
                            if (!sftpInitialized) finalize(e);
                        });
                        stream.on('end', () => {
                            try { sftp.push(null); } catch { /* ignore */ }
                        });
                    } catch (e: any) {
                        finalize(e);
                    }
                };
                const initSftp = () => {
                    if (sftpInitialized) return;
                    if (!sftpCreated) createSftp();
                    try {
                        sftp._init();
                        if (pendingAfterMarker && pendingAfterMarker.length > 0) {
                            try { sftp.push(pendingAfterMarker); } catch { /* ignore */ }
                            pendingAfterMarker = null;
                        }
                    } catch (e: any) {
                        finalize(e);
                    }
                };
                const onStdout = (data: Buffer) => {
                    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                    stdoutBuffer = stdoutBuffer.length > 0 ? Buffer.concat([stdoutBuffer, chunk]) : chunk;
                    const markerIndex = stdoutBuffer.indexOf(readyMarkerBuffer);
                    if (markerIndex !== -1) {
                        const afterMarkerIndex = markerIndex + readyMarkerBuffer.length;
                        if (afterMarkerIndex < stdoutBuffer.length) {
                            pendingAfterMarker = stdoutBuffer.subarray(afterMarkerIndex);
                        }
                        // 检测到标记，停止监听 stdout，交给 SFTP 解析器
                        stream.removeListener('data', onStdout);
                        stdoutBuffer = Buffer.alloc(0);
                        console.log('[SFTP] 检测到 SFTPREADY，等待流稳定后初始化协议...');
                        setTimeout(() => initSftp(), 1000);
                    } else if (stdoutBuffer.length > 256) {
                        stdoutBuffer = stdoutBuffer.subarray(stdoutBuffer.length - 256);
                    }
                };
                const onStderr = (data: Buffer) => {
                    stderrBuffer += data.toString();
                    if (stderrBuffer.includes(prompt)) {
                        console.log('[SFTP] sudo 请求密码，正在发送...');
                        stream.write((password || '') + '\n');
                        stderrBuffer = '';
                    } else if (stderrBuffer.length > 256) {
                        stderrBuffer = stderrBuffer.slice(-256);
                    }
                };
                stream.on('data', onStdout);
                stream.stderr.on('data', onStderr);
                stream.on('exit', (code: number) => {
                    console.log(`[SFTP] sudo 流退出，退出码 ${code}`);
                    if (!sftpInitialized && code !== 0) {
                        let msg = `SFTP sudo 失败，退出码 ${code}。`;
                        if (code === 1) msg += ' 密码可能错误或 sudo 权限被拒绝。';
                        else if (code === 127) msg += ' 远程系统未找到 sftp-server。';
                        finalize(new Error(msg));
                    }
                });
            });
        });
    }
    // --- SFTP 操作方法 ---

    /** 读取目录内容 */
    async readdir(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
             console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 readdir (ID: ${requestId})`);
             state?.ws.send(JSON.stringify({ type: 'sftp:readdir:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
             return;
        }
        console.debug(`[SFTP ${sessionId}] Received readdir request for ${path} (ID: ${requestId})`);
        try {
            state.sftp.readdir(path, (err, list) => {
                 if (err) {
                    console.error(`[SFTP ${sessionId}] readdir ${path} failed (ID: ${requestId}):`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:readdir:error', path: path, payload: `读取目录失败: ${err.message}`, requestId: requestId }));
                 } else {
                    const files = list.map((item) => ({
                        filename: item.filename,
                        longname: item.longname,
                        attrs: {
                            size: item.attrs.size, uid: item.attrs.uid, gid: item.attrs.gid, mode: item.attrs.mode,
                            atime: item.attrs.atime * 1000, mtime: item.attrs.mtime * 1000,
                            isDirectory: item.attrs.isDirectory(), isFile: item.attrs.isFile(), isSymbolicLink: item.attrs.isSymbolicLink(),
                         }
                     }));
                    state.ws.send(JSON.stringify({ type: 'sftp:readdir:success', path: path, payload: files, requestId: requestId }));
                 }
            });
        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] readdir ${path} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:readdir:error', path: path, payload: `读取目录时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }

    /** 获取文件/目录状态信息 */
    async stat(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
         if (!state || !state.sftp) {
             console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 stat (ID: ${requestId})`);
             state?.ws.send(JSON.stringify({ type: 'sftp:stat:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId })); // Use specific error type
             return;
         }
        console.debug(`[SFTP ${sessionId}] Received stat request for ${path} (ID: ${requestId})`);
        try {
            state.sftp.lstat(path, (err, stats: Stats) => {
                if (err) {
                    console.error(`[SFTP ${sessionId}] stat ${path} failed (ID: ${requestId}):`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:stat:error', path: path, payload: `获取状态失败: ${err.message}`, requestId: requestId }));
                } else {
                     const fileStats = {
                         size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                         atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                         isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                     };
                    // Send specific success type
                    state.ws.send(JSON.stringify({ type: 'sftp:stat:success', path: path, payload: fileStats, requestId: requestId }));
                }
            });
        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] stat ${path} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:stat:error', path: path, payload: `获取状态时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }

    /** 读取文件内容 (支持指定编码) */
    async readFile(sessionId: string, path: string, requestId: string, requestedEncoding?: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 readFile (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
            return;
        }
        console.debug(`[SFTP ${sessionId}] Received readFile request for ${path} (ID: ${requestId}, Requested Encoding: ${requestedEncoding ?? 'auto'})`);
        try {
            const readStream = state.sftp.createReadStream(path);
            let fileData = Buffer.alloc(0);
            let errorOccurred = false;

            readStream.on('data', (chunk: Buffer) => { fileData = Buffer.concat([fileData, chunk]); });
            readStream.on('error', (err: Error) => {
                if (errorOccurred) return; errorOccurred = true;
                console.error(`[SFTP ${sessionId}] readFile ${path} stream error (ID: ${requestId}):`, err);
                state.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path: path, payload: `读取文件流错误: ${err.message}`, requestId: requestId }));
            });
            readStream.on('end', () => {
                if (errorOccurred) return;

                console.log(`[SFTP ${sessionId}] readFile ${path} success, size: ${fileData.length} bytes (ID: ${requestId}). Processing content...`);
                let encodingUsed: string = 'utf-8'; // Default encoding
                let decodedContent: string = '';
                let decodeError: string | null = null;

                try {
                    if (requestedEncoding) {
                        // 用户指定了编码
                        encodingUsed = requestedEncoding;
                        console.log(`[SFTP ${sessionId}] Using requested encoding: ${encodingUsed} (ID: ${requestId})`);
                        const normalizedEncoding = encodingUsed.toLowerCase().replace(/[^a-z0-9]/g, ''); // Normalize more aggressively
                        if (iconv.encodingExists(normalizedEncoding)) {
                            decodedContent = iconv.decode(fileData, normalizedEncoding);
                            encodingUsed = normalizedEncoding; // Use the normalized name if valid
                        } else {
                            console.warn(`[SFTP ${sessionId}] Requested encoding "${requestedEncoding}" is not supported by iconv-lite. Falling back to UTF-8. (ID: ${requestId})`);
                            encodingUsed = 'utf-8'; // Fallback
                            decodedContent = iconv.decode(fileData, encodingUsed);
                            // Optionally add a warning?
                        }
                    } else {
                        // 自动检测编码
                        console.log(`[SFTP ${sessionId}] Detecting encoding for ${path} (ID: ${requestId})`);
                        const detection = jschardet.detect(fileData);
                        const detectedEncodingRaw = detection.encoding ? detection.encoding.toLowerCase() : 'utf-8'; // Default to utf-8 if detection fails
                        const confidence = detection.confidence || 0;
                        console.log(`[SFTP ${sessionId}] Detected encoding: ${detectedEncodingRaw} (confidence: ${confidence})`);

                        const chineseEncodings = ['gbk', 'gb2312', 'gb18030', 'big5', 'euc-tw'];
                        let normalizedDetected = detectedEncodingRaw.replace(/[^a-z0-9]/g, '');
                        if (normalizedDetected === 'windows1252') normalizedDetected = 'cp1252';
                        else if (normalizedDetected === 'gb2312') normalizedDetected = 'gbk'; // Prefer gbk

                        if (normalizedDetected === 'utf8' || normalizedDetected === 'ascii') {
                            encodingUsed = 'utf-8';
                            decodedContent = fileData.toString('utf8');
                            console.log(`[SFTP ${sessionId}] Decoded ${path} as UTF-8/ASCII.`);
                        } else if (chineseEncodings.includes(normalizedDetected)) {
                            // If detected as a common Chinese encoding, trust it and use gb18030 for broader compatibility
                            encodingUsed = 'gb18030'; // Report gb18030 as used
                            decodedContent = iconv.decode(fileData, encodingUsed);
                            console.log(`[SFTP ${sessionId}] Decoded ${path} from detected Chinese encoding (${normalizedDetected}) as ${encodingUsed}.`);
                        } else if (confidence < 0.90) { // Low confidence threshold
                            console.warn(`[SFTP ${sessionId}] Low confidence detection (${normalizedDetected}, ${confidence}) for ${path}. Attempting GB18030 decode first.`);
                            try {
                                // Try decoding as GB18030 first
                                const tempContent = iconv.decode(fileData, 'gb18030');
                                // Basic check for Mojibake
                                if (tempContent.includes('\uFFFD')) {
                                     console.warn(`[SFTP ${sessionId}] GB18030 decoding resulted in replacement characters. Falling back to original detection (${normalizedDetected}) or UTF-8.`);
                                     // Fallback: Try the originally detected encoding if supported, otherwise UTF-8
                                     if (iconv.encodingExists(normalizedDetected)) {
                                         encodingUsed = normalizedDetected;
                                         decodedContent = iconv.decode(fileData, encodingUsed);
                                         console.log(`[SFTP ${sessionId}] Falling back to decoding ${path} as originally detected ${encodingUsed}.`);
                                     } else {
                                         encodingUsed = 'utf-8';
                                         decodedContent = fileData.toString('utf8');
                                         console.log(`[SFTP ${sessionId}] Falling back to decoding ${path} as UTF-8.`);
                                     }
                                } else {
                                     encodingUsed = 'gb18030'; // Success with GB18030
                                     decodedContent = tempContent;
                                     console.log(`[SFTP ${sessionId}] Decoded ${path} as ${encodingUsed} due to low confidence detection.`);
                                }
                            } catch (gbkError) {
                                console.warn(`[SFTP ${sessionId}] Error decoding as GB18030, falling back to original detection (${normalizedDetected}) or UTF-8:`, gbkError);
                                // Fallback: Try the originally detected encoding if supported, otherwise UTF-8
                                if (iconv.encodingExists(normalizedDetected)) {
                                    encodingUsed = normalizedDetected;
                                    decodedContent = iconv.decode(fileData, encodingUsed);
                                    console.log(`[SFTP ${sessionId}] Falling back to decoding ${path} as originally detected ${encodingUsed}.`);
                                } else {
                                    encodingUsed = 'utf-8';
                                    decodedContent = fileData.toString('utf8');
                                    console.log(`[SFTP ${sessionId}] Falling back to decoding ${path} as UTF-8.`);
                                }
                            }
                        } else if (iconv.encodingExists(normalizedDetected)) {
                            // Higher confidence, non-Chinese, supported encoding
                            encodingUsed = normalizedDetected;
                            decodedContent = iconv.decode(fileData, encodingUsed);
                            console.log(`[SFTP ${sessionId}] Decoded ${path} from ${encodingUsed} using iconv-lite (high confidence).`);
                        } else {
                            console.warn(`[SFTP ${sessionId}] Unsupported or unknown encoding detected for ${path}: ${normalizedDetected}. Falling back to UTF-8.`);
                            encodingUsed = 'utf-8'; // Final fallback
                            decodedContent = fileData.toString('utf8');
                        }
                    }

                    // Final check for replacement characters after deciding the encoding
                    if (decodedContent.includes('\uFFFD')) {
                         console.warn(`[SFTP ${sessionId}] Final decoded content for ${path} (using ${encodingUsed}) contains replacement characters (U+FFFD). Decoding might be incorrect. (ID: ${requestId})`);
                         // decodeError = `解码内容可能不正确 (使用 ${encodingUsed})，检测到无效字符。`; // Optionally set error
                    }

                } catch (err: any) {
                    console.error(`[SFTP ${sessionId}] Error detecting/decoding file content for ${path} (ID: ${requestId}):`, err);
                    decodeError = `文件编码检测或转换失败: ${err.message}`;
                    state.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path: path, payload: decodeError, requestId: requestId }));
                    return; // Stop processing
                }

                // 发送 Base64 编码的原始数据和实际使用的编码
                console.log(`[SFTP ${sessionId}] Sending raw content (Base64) and encoding used (${encodingUsed}) for ${path} (ID: ${requestId})`);
                state.ws.send(JSON.stringify({
                    type: 'sftp:readfile:success',
                    path: path,
                    payload: {
                        rawContentBase64: fileData.toString('base64'), // 发送 Base64 字符串
                        encodingUsed: encodingUsed // 发送实际使用的编码
                    },
                    requestId: requestId
                }));
            });
        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] readFile ${path} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path: path, payload: `读取文件时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }

    /** 写入文件内容 (支持指定编码) */
    // --- 修改：添加 encoding 参数 ---
    async writefile(sessionId: string, path: string, data: string, requestId: string, encoding?: string): Promise<void> {
         const state = this.clientStates.get(sessionId);
         if (!state || !state.sftp) {
             console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 writefile (ID: ${requestId})`);
             state?.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
             return;
         }
        // --- 修改：使用传入的 encoding 或默认 utf-8 ---
        const targetEncoding = encoding || 'utf-8';
        console.debug(`[SFTP ${sessionId}] Received writefile request for ${path} (ID: ${requestId}, Encoding: ${targetEncoding})`);
        try {
            // --- 修改：使用 iconv-lite 根据指定编码创建 Buffer ---
            let buffer: Buffer;
            try {
                buffer = iconv.encode(data, targetEncoding);
                console.log(`[SFTP ${sessionId}] Encoded content for ${path} using ${targetEncoding} (Buffer size: ${buffer.length})`);
            } catch (encodeError: any) {
                 console.error(`[SFTP ${sessionId}] Failed to encode content for ${path} with encoding ${targetEncoding} (ID: ${requestId}):`, encodeError);
                 state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: path, payload: `无效的编码或编码失败: ${targetEncoding}`, requestId: requestId }));
                 return;
            }

            // 获取文件当前权限
            let originalMode: number | undefined;
            try {
                const stats = await new Promise<Stats>((resolve, reject) => {
                    state.sftp!.lstat(path, (err, stats) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(stats);
                        }
                    });
                });
                originalMode = stats.mode;
                console.log(`[SFTP ${sessionId}] Retrieved original file mode for ${path}: ${originalMode.toString(8)} (ID: ${requestId})`);
            } catch (statError: any) {
                console.warn(`[SFTP ${sessionId}] Could not retrieve original file mode for ${path} (ID: ${requestId}):`, statError);
                // 如果文件不存在或其他错误，继续写入操作，不设置权限
            }

            console.debug(`[SFTP ${sessionId}] Creating write stream for ${path} (ID: ${requestId})`);
            // 在创建写入流时设置文件权限
            const writeStreamOptions = originalMode !== undefined ? { mode: originalMode } : {};
            const writeStream = state.sftp.createWriteStream(path, writeStreamOptions);
            let errorOccurred = false;

            writeStream.on('error', (err: Error) => {
                if (errorOccurred) return; // Prevent sending multiple errors
                errorOccurred = true;
                console.error(`[SFTP ${sessionId}] writefile ${path} stream error (ID: ${requestId}):`, err);
                state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: path, payload: `写入文件流错误: ${err.message}`, requestId: requestId }));
            });

            // Listen for the 'close' event which indicates the stream has finished writing and the file descriptor is closed.
            writeStream.on('close', () => {
                if (!errorOccurred) {
                    console.log(`[SFTP ${sessionId}] writefile ${path} stream closed successfully (ID: ${requestId}). Fetching updated stats...`);
                    if (originalMode !== undefined) {
                        console.log(`[SFTP ${sessionId}] Set file mode for ${path} during creation: ${originalMode.toString(8)} (ID: ${requestId})`);
                    }
                    // Get updated stats after writing
                    state.sftp!.lstat(path, (statErr, stats) => {
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] lstat after writefile ${path} failed (ID: ${requestId}):`, statErr);
                            state.ws.send(JSON.stringify({ type: 'sftp:writefile:success', path: path, payload: null, requestId: requestId }));
                        } else {
                            const updatedItem = {
                                filename: path.substring(path.lastIndexOf('/') + 1),
                                longname: '',
                                attrs: {
                                    size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                                    atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                                    isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                                }
                            };
                            console.log(`[SFTP ${sessionId}] Sending writefile success with updated item for ${path} (ID: ${requestId})`);
                            state.ws.send(JSON.stringify({ type: 'sftp:writefile:success', path: path, payload: updatedItem, requestId: requestId }));
                        }
                    });
                }
            });

            console.debug(`[SFTP ${sessionId}] Writing ${buffer.length} bytes to ${path} (ID: ${requestId})`);
            writeStream.end(buffer); // Start writing and close the stream afterwards
            console.debug(`[SFTP ${sessionId}] writefile ${path} end() called (ID: ${requestId})`);

            // Success message is now sent in the 'close' event handler

        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] writefile ${path} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: path, payload: `写入文件时发生意外错误: ${error.message}`, requestId: requestId }));
         }
    }

    /** 创建目录 */
    async mkdir(sessionId: string, path: string, requestId: string): Promise<void> {
         const state = this.clientStates.get(sessionId);
         if (!state || !state.sftp) {
             console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 mkdir (ID: ${requestId})`);
             state?.ws.send(JSON.stringify({ type: 'sftp:mkdir:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId })); // Use specific error type
             return;
         }
        console.debug(`[SFTP ${sessionId}] Received mkdir request for ${path} (ID: ${requestId})`);
        try {
            state.sftp.mkdir(path, (err) => {
                if (err) {
                    console.error(`[SFTP ${sessionId}] mkdir ${path} failed (ID: ${requestId}):`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:mkdir:error', path: path, payload: `创建目录失败: ${err.message}`, requestId: requestId }));
                } else {
                    console.log(`[SFTP ${sessionId}] mkdir ${path} success (ID: ${requestId}). Fetching stats...`);
                    // Get stats for the new directory
                    state.sftp!.lstat(path, (statErr, stats) => {
                         if (statErr) {
                            console.error(`[SFTP ${sessionId}] lstat after mkdir ${path} failed (ID: ${requestId}):`, statErr);
                            // Send success anyway, but without item details
                            state.ws.send(JSON.stringify({ type: 'sftp:mkdir:success', path: path, payload: null, requestId: requestId }));
                         } else {
                            const newItem = {
                                filename: path.substring(path.lastIndexOf('/') + 1),
                                longname: '', // lstat doesn't provide longname
                                attrs: {
                                    size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                                    atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                                    isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                                }
                            };
                            console.log(`[SFTP ${sessionId}] Sending mkdir success with new item for ${path} (ID: ${requestId})`);
                            state.ws.send(JSON.stringify({ type: 'sftp:mkdir:success', path: path, payload: newItem, requestId: requestId }));
                         }
                    });
                }
            });
        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] mkdir ${path} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:mkdir:error', path: path, payload: `创建目录时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }

    /** 删除目录 (强制递归) */
    async rmdir(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) { 
            console.warn(`[SSH Exec] SSH 客户端未准备好，无法在 ${sessionId} 上执行 rmdir (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path: path, payload: 'SSH 会话未就绪', requestId: requestId }));
            return;
        }
        console.debug(`[SSH Exec ${sessionId}] Received rmdir request for ${path} (ID: ${requestId})`);

        // 第一种方案：尝试 rm -rf 命令
        const tryRmRfCommand = async (isSudo: boolean) => {
            const commandPrefix = isSudo ? 'sudo ' : '';
            const command = `${commandPrefix}rm -rf "${path.replace(/"/g, '\\"')}"`;
            const attemptDescription = isSudo ? 'sudo rm -rf' : 'rm -rf';

            console.log(`[SSH Exec ${sessionId}] 尝试使用 ${attemptDescription} 命令删除 ${path} (ID: ${requestId})`);
            console.log(`[SSH Exec ${sessionId}] Executing command: ${command} (ID: ${requestId})`);

            try {
                state.sshClient.exec(command, (err, stream) => {
                    if (err) {
                        console.error(`[SSH Exec ${sessionId}] Failed to start exec for ${attemptDescription} ${path} (ID: ${requestId}):`, err);
                        if (!isSudo) {
                            // 如果普通 rm -rf 失败，尝试 sudo rm -rf
                            tryRmRfCommand(true);
                        } else {
                            // 如果 sudo rm -rf 也失败
                            state.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path: path, payload: `删除目录失败: ${attemptDescription} 命令执行失败: ${err.message}`, requestId: requestId }));
                        }
                        return;
                    }

                    let stderrOutput = '';
                    stream.stderr.on('data', (data: Buffer) => {
                        stderrOutput += data.toString();
                    });

                    stream.on('close', (code: number | null, signal: string | null) => {
                        if (code === 0) {
                            console.log(`[SSH Exec ${sessionId}] ${attemptDescription} ${path} command executed successfully (ID: ${requestId})`);
                            state.ws.send(JSON.stringify({ type: 'sftp:rmdir:success', path: path, requestId: requestId }));
                        } else {
                            const errorMessage = stderrOutput.trim() || `命令退出，代码: ${code ?? 'N/A'}${signal ? `, 信号: ${signal}` : ''}`;
                            console.error(`[SSH Exec ${sessionId}] ${attemptDescription} ${path} command failed (ID: ${requestId}). Code: ${code}, Signal: ${signal}, Stderr: ${errorMessage}`);
                            if (!isSudo) {
                                // 如果普通 rm -rf 失败，尝试 sudo rm -rf
                                console.log(`[SSH Exec ${sessionId}] 普通 rm -rf 失败，错误: ${errorMessage}。尝试 sudo rm -rf。`);
                                tryRmRfCommand(true);
                            } else {
                                // 如果 sudo rm -rf 也失败
                                state.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path: path, payload: `删除目录失败: 普通 rm -rf 和 sudo rm -rf 命令均失败。最后错误: ${errorMessage}`, requestId: requestId }));
                            }
                        }
                    });

                    stream.on('data', (data: Buffer) => {
                        console.debug(`[SSH Exec ${sessionId}] ${attemptDescription} stdout (ID: ${requestId}): ${data.toString()}`);
                    });
                });
            } catch (error: any) {
                console.error(`[SSH Exec ${sessionId}] ${attemptDescription} ${path} caught unexpected error during exec setup (ID: ${requestId}):`, error);
                if (!isSudo) {
                     // 如果普通 rm -rf 期间发生意外错误，尝试 sudo rm -rf
                    console.log(`[SSH Exec ${sessionId}] 普通 rm -rf 发生意外错误。尝试 sudo rm -rf。`);
                    tryRmRfCommand(true);
                } else {
                    state.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path: path, payload: `删除目录失败: ${attemptDescription} 执行时发生意外错误: ${error.message}`, requestId: requestId }));
                }
            }
        };

        // 首先尝试不带 sudo 的 rm -rf
        tryRmRfCommand(false);
    }

    /** 删除文件 */
     async unlink(sessionId: string, path: string, requestId: string): Promise<void> {
         const state = this.clientStates.get(sessionId);
         if (!state || !state.sftp) {
             console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 unlink (ID: ${requestId})`);
             state?.ws.send(JSON.stringify({ type: 'sftp:unlink:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId })); // Use specific error type
             return;
         }
        console.debug(`[SFTP ${sessionId}] Received unlink request for ${path} (ID: ${requestId})`);
        try {
            state.sftp.unlink(path, (err) => {
                if (err) {
                    console.error(`[SFTP ${sessionId}] unlink ${path} failed (ID: ${requestId}):`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:unlink:error', path: path, payload: `删除文件失败: ${err.message}`, requestId: requestId }));
                } else {
                    console.log(`[SFTP ${sessionId}] unlink ${path} success (ID: ${requestId})`);
                    state.ws.send(JSON.stringify({ type: 'sftp:unlink:success', path: path, requestId: requestId })); // Send specific success type
                }
            });
        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] unlink ${path} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:unlink:error', path: path, payload: `删除文件时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }

    /** 重命名/移动文件或目录 */
     async rename(sessionId: string, oldPath: string, newPath: string, requestId: string): Promise<void> {
         const state = this.clientStates.get(sessionId);
         if (!state || !state.sftp) {
             console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 rename (ID: ${requestId})`);
             state?.ws.send(JSON.stringify({ type: 'sftp:rename:error', oldPath: oldPath, newPath: newPath, payload: 'SFTP 会话未就绪', requestId: requestId })); // Use specific error type
             return;
         }
        console.debug(`[SFTP ${sessionId}] Received rename request ${oldPath} -> ${newPath} (ID: ${requestId})`);
        try {
            state.sftp.rename(oldPath, newPath, (err) => {
                if (err) {
                    console.error(`[SFTP ${sessionId}] rename ${oldPath} -> ${newPath} failed (ID: ${requestId}):`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:rename:error', oldPath: oldPath, newPath: newPath, payload: `重命名/移动失败: ${err.message}`, requestId: requestId }));
                } else {
                    console.log(`[SFTP ${sessionId}] rename ${oldPath} -> ${newPath} success (ID: ${requestId}). Fetching stats for new path...`);
                    // Get stats for the new path
                    state.sftp!.lstat(newPath, (statErr, stats) => {
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] lstat after rename ${newPath} failed (ID: ${requestId}):`, statErr);
                            // Send success anyway, but without item details
                            state.ws.send(JSON.stringify({ type: 'sftp:rename:success', payload: { oldPath: oldPath, newPath: newPath, newItem: null }, requestId: requestId }));
                        } else {
                            const newItem = {
                                filename: newPath.substring(newPath.lastIndexOf('/') + 1),
                                longname: '', // lstat doesn't provide longname
                                attrs: {
                                    size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                                    atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                                    isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                                }
                            };
                            console.log(`[SFTP ${sessionId}] Sending rename success with new item for ${newPath} (ID: ${requestId})`);
                            state.ws.send(JSON.stringify({ type: 'sftp:rename:success', payload: { oldPath: oldPath, newPath: newPath, newItem: newItem }, requestId: requestId }));
                        }
                    });
                }
            });
        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] rename ${oldPath} -> ${newPath} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:rename:error', oldPath: oldPath, newPath: newPath, payload: `重命名/移动时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }

    /** 修改文件/目录权限 */
     async chmod(sessionId: string, path: string, mode: number, requestId: string): Promise<void> {
         const state = this.clientStates.get(sessionId);
         if (!state || !state.sftp) {
             console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 chmod (ID: ${requestId})`);
             state?.ws.send(JSON.stringify({ type: 'sftp:chmod:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId })); // Use specific error type
             return;
         }
        console.debug(`[SFTP ${sessionId}] Received chmod request for ${path} to ${mode.toString(8)} (ID: ${requestId})`);
        try {
            state.sftp.chmod(path, mode, (err) => {
                if (err) {
                    console.error(`[SFTP ${sessionId}] chmod ${path} to ${mode.toString(8)} failed (ID: ${requestId}):`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:chmod:error', path: path, payload: `修改权限失败: ${err.message}`, requestId: requestId }));
                } else {
                    console.log(`[SFTP ${sessionId}] chmod ${path} to ${mode.toString(8)} success (ID: ${requestId}). Fetching updated stats...`);
                    // Get updated stats after chmod
                    state.sftp!.lstat(path, (statErr, stats) => {
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] lstat after chmod ${path} failed (ID: ${requestId}):`, statErr);
                            // Send success anyway, but without updated item details
                            state.ws.send(JSON.stringify({ type: 'sftp:chmod:success', path: path, payload: null, requestId: requestId }));
                        } else {
                            const updatedItem = {
                                filename: path.substring(path.lastIndexOf('/') + 1),
                                longname: '', // lstat doesn't provide longname
                                attrs: {
                                    size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                                    atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                                    isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                                }
                            };
                            console.log(`[SFTP ${sessionId}] Sending chmod success with updated item for ${path} (ID: ${requestId})`);
                            state.ws.send(JSON.stringify({ type: 'sftp:chmod:success', path: path, payload: updatedItem, requestId: requestId }));
                        }
                    });
                }
            });
        } catch (error: any) {
             console.error(`[SFTP ${sessionId}] chmod ${path} caught unexpected error (ID: ${requestId}):`, error);
             state.ws.send(JSON.stringify({ type: 'sftp:chmod:error', path: path, payload: `修改权限时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }


    /** 获取路径的绝对表示 */
    async realpath(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 realpath (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:realpath:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
            return;
        }
        console.debug(`[SFTP ${sessionId}] Received realpath request for ${path} (ID: ${requestId})`);
        try {
            state.sftp.realpath(path, (err, absPath) => {
                if (err) {
                    console.error(`[SFTP ${sessionId}] realpath ${path} failed (ID: ${requestId}):`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:realpath:error', path: path, payload: { requestedPath: path, error: `获取绝对路径失败: ${err.message}` }, requestId: requestId }));
                } else {
                    console.log(`[SFTP ${sessionId}] realpath ${path} -> ${absPath} success (ID: ${requestId}). Fetching target type...`);
                    // 再次检查 state 和 state.sftp 是否仍然有效，因为回调是异步的
                    const currentState = this.clientStates.get(sessionId);
                    if (!currentState || !currentState.sftp) {
                        console.warn(`[SFTP ${sessionId}] SFTP session for ${absPath} became invalid before stat call (ID: ${requestId}).`);
                        // 即使 SFTP 会话失效，也尝试发送已解析的路径，但标记错误
                        state.ws.send(JSON.stringify({
                            type: 'sftp:realpath:error',
                            path: path, // 原始请求路径
                            payload: {
                                requestedPath: path,
                                absolutePath: absPath,
                                error: 'SFTP 会话在获取目标类型前已失效'
                            },
                            requestId: requestId
                        }));
                        return;
                    }
                    // 对 absPath 执行 stat 操作以获取其真实类型
                    currentState.sftp.stat(absPath, (statErr, stats) => { // 使用 sftp.stat()
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] stat on realpath target ${absPath} failed (ID: ${requestId}):`, statErr);
                            // 如果 stat 失败，发送带有错误信息的 realpath:error，但仍包含已解析的路径
                            state.ws.send(JSON.stringify({
                                type: 'sftp:realpath:error',
                                path: path, // 原始请求路径
                                payload: {
                                    requestedPath: path,
                                    absolutePath: absPath, // 仍然发送已解析的路径
                                    error: `获取目标类型失败: ${statErr.message}`
                                },
                                requestId: requestId
                            }));
                        } else {
                            let targetType: 'file' | 'directory' | 'unknown' = 'unknown';
                            if (stats.isFile()) {
                                targetType = 'file';
                            } else if (stats.isDirectory()) {
                                targetType = 'directory';
                            }
                            console.log(`[SFTP ${sessionId}] Target type for ${absPath} is ${targetType} (ID: ${requestId})`);
                            state.ws.send(JSON.stringify({
                                type: 'sftp:realpath:success',
                                path: path, // 原始请求路径
                                payload: {
                                    requestedPath: path,
                                    absolutePath: absPath,
                                    targetType: targetType // 新增字段
                                },
                                requestId: requestId
                            }));
                        }
                    });
                }
            });
        } catch (error: any) {
            console.error(`[SFTP ${sessionId}] realpath ${path} caught unexpected error (ID: ${requestId}):`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:realpath:error', path: path, payload: `获取绝对路径时发生意外错误: ${error.message}`, requestId: requestId }));
        }
    }

    // +++ 复制文件或目录 +++
    async copy(sessionId: string, sources: string[], destinationDir: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP Copy] SFTP 未准备好，无法在 ${sessionId} 上执行 copy (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:copy:error', payload: 'SFTP 会话未就绪', requestId: requestId }));
            return;
        }
        const sftp = state.sftp;
        console.debug(`[SFTP ${sessionId}] Received copy request (ID: ${requestId}) Sources: ${sources.join(', ')}, Dest: ${destinationDir}`);

        const copiedItemsDetails: any[] = []; // Store details of successfully copied items
        let firstError: Error | null = null;

        try {
            // Ensure destination directory exists
            try {
                await this.ensureDirectoryExists(sftp, destinationDir);
            } catch (ensureErr: any) {
                 console.error(`[SFTP ${sessionId}] Failed to ensure destination directory ${destinationDir} exists (ID: ${requestId}):`, ensureErr);
                 throw new Error(`无法创建或访问目标目录: ${ensureErr.message}`);
            }

            for (const sourcePath of sources) {
                const sourceName = pathModule.basename(sourcePath);
                const destPath = pathModule.join(destinationDir, sourceName).replace(/\\/g, '/'); // Ensure forward slashes

                if (sourcePath === destPath) {
                     console.warn(`[SFTP ${sessionId}] Skipping copy: source and destination are the same (${sourcePath}) (ID: ${requestId})`);
                     continue; // Skip if source and destination are identical
                }

                try {
                    const stats = await this.getStats(sftp, sourcePath);
                    if (stats.isDirectory()) {
                        console.log(`[SFTP ${sessionId}] Copying directory ${sourcePath} to ${destPath} (ID: ${requestId})`);
                        await this.copyDirectoryRecursive(sftp, sourcePath, destPath);
                    } else if (stats.isFile()) {
                        console.log(`[SFTP ${sessionId}] Copying file ${sourcePath} to ${destPath} (ID: ${requestId})`);
                        await this.copyFile(sftp, sourcePath, destPath);
                    } else {
                        // Handle symlinks or other types if necessary, for now just skip/warn
                        console.warn(`[SFTP ${sessionId}] Skipping copy of unsupported file type: ${sourcePath} (ID: ${requestId})`);
                        continue;
                    }
                    // Get stats of the *newly copied* item
                    const copiedStats = await this.getStats(sftp, destPath);
                    copiedItemsDetails.push(this.formatStatsToFileListItem(destPath, copiedStats));

                } catch (copyErr: any) {
                    console.error(`[SFTP ${sessionId}] Error copying ${sourcePath} to ${destPath} (ID: ${requestId}):`, copyErr);
                    firstError = copyErr; // Store the first error encountered
                    break; // Stop processing further sources on error
                }
            }

            if (firstError) {
                throw firstError; // Throw the first error to be caught below
            }

            // Send success message with details of copied items
            console.log(`[SFTP ${sessionId}] Copy operation completed successfully (ID: ${requestId}). Copied items: ${copiedItemsDetails.length}`);
            state.ws.send(JSON.stringify({
                type: 'sftp:copy:success',
                payload: { destination: destinationDir, items: copiedItemsDetails },
                requestId: requestId
            }));

        } catch (error: any) {
            console.error(`[SFTP ${sessionId}] Copy operation failed (ID: ${requestId}):`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:copy:error', payload: `复制操作失败: ${error.message}`, requestId: requestId }));
        }
    }

    // +++ 移动文件或目录 +++
    async move(sessionId: string, sources: string[], destinationDir: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP Move] SFTP 未准备好，无法在 ${sessionId} 上执行 move (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:move:error', payload: 'SFTP 会话未就绪', requestId: requestId }));
            return;
        }
        const sftp = state.sftp;
        console.debug(`[SFTP ${sessionId}] Received move request (ID: ${requestId}) Sources: ${sources.join(', ')}, Dest: ${destinationDir}`);

        const movedItemsDetails: any[] = [];
        let firstError: Error | null = null;

        try {
             // Ensure destination directory exists (important for move)
            try {
                await this.ensureDirectoryExists(sftp, destinationDir);
            } catch (ensureErr: any) {
                 console.error(`[SFTP ${sessionId}] Failed to ensure destination directory ${destinationDir} exists for move (ID: ${requestId}):`, ensureErr);
                 throw new Error(`无法创建或访问目标目录: ${ensureErr.message}`);
            }

            for (const oldPath of sources) {
                const sourceName = pathModule.basename(oldPath);
                const newPath = pathModule.join(destinationDir, sourceName).replace(/\\/g, '/'); // Ensure forward slashes

                 if (oldPath === newPath) {
                     console.warn(`[SFTP ${sessionId}] Skipping move: source and destination are the same (${oldPath}) (ID: ${requestId})`);
                     continue; // Skip if source and destination are identical
                 }

                try {
                    // --- 移动前检查目标是否存在 ---
                    let targetExists = false;
                    try {
                        await this.getStats(sftp, newPath);
                        targetExists = true;
                    } catch (statErr: any) {
                        if (!(statErr.code === 'ENOENT' || (statErr.message && statErr.message.includes('No such file')))) {
                            // 如果 stat 失败不是因为 "No such file"，则抛出未知错误
                            throw new Error(`检查目标路径 ${newPath} 状态时出错: ${statErr.message}`);
                        }
                        // 如果是 "No such file"，则 targetExists 保持 false，可以继续移动
                    }

                    if (targetExists) {
                        console.error(`[SFTP ${sessionId}] Move failed: Target path ${newPath} already exists (ID: ${requestId})`);
                        throw new Error(`目标路径 ${pathModule.basename(newPath)} 已存在`);
                    }
                    
                    console.log(`[SFTP ${sessionId}] Moving ${oldPath} to ${newPath} (ID: ${requestId})`);
                    await this.performRename(sftp, oldPath, newPath); // Use helper for rename logic

                    // Get stats of the *moved* item at the new location
                    const movedStats = await this.getStats(sftp, newPath);
                    movedItemsDetails.push(this.formatStatsToFileListItem(newPath, movedStats));

                } catch (moveErr: any) {
                    console.error(`[SFTP ${sessionId}] Error moving ${oldPath} to ${newPath} (ID: ${requestId}):`, moveErr);
                    firstError = moveErr;
                    break; // Stop on first error for move
                }
            }

            if (firstError) {
                throw firstError;
            }

            console.log(`[SFTP ${sessionId}] Move operation completed successfully (ID: ${requestId}). Moved items: ${movedItemsDetails.length}`);
            state.ws.send(JSON.stringify({
                type: 'sftp:move:success',
                payload: { sources: sources, destination: destinationDir, items: movedItemsDetails },
                requestId: requestId
            }));

        } catch (error: any) {
            console.error(`[SFTP ${sessionId}] Move operation failed (ID: ${requestId}):`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:move:error', payload: `移动操作失败: ${error.message}`, requestId: requestId }));
        }
    }

    // +++ 辅助方法 - 复制文件 +++
    private copyFile(sftp: SFTPWrapper, sourcePath: string, destPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const readStream = sftp.createReadStream(sourcePath);
            const writeStream = sftp.createWriteStream(destPath);
            let errorOccurred = false;

            const onError = (err: Error) => {
                if (errorOccurred) return;
                errorOccurred = true;
                // Ensure streams are destroyed on error
                readStream.destroy();
                writeStream.destroy();
                console.error(`Error copying file ${sourcePath} to ${destPath}:`, err);
                reject(new Error(`复制文件失败: ${err.message}`));
            };

            readStream.on('error', onError);
            writeStream.on('error', onError);

            writeStream.on('close', () => { // Use 'close' for write stream completion
                if (!errorOccurred) {
                    resolve();
                }
            });

            readStream.pipe(writeStream);
        });
    }

    // +++ 辅助方法 - 递归复制目录 +++
    private async copyDirectoryRecursive(sftp: SFTPWrapper, sourcePath: string, destPath: string): Promise<void> {
        try {
            // Create destination directory
            await this.ensureDirectoryExists(sftp, destPath);

            // Read source directory contents
            const items = await this.listDirectory(sftp, sourcePath);

            for (const item of items) {
                const currentSourcePath = pathModule.join(sourcePath, item.filename).replace(/\\/g, '/');
                const currentDestPath = pathModule.join(destPath, item.filename).replace(/\\/g, '/');
                const itemStats = item.attrs; // Assuming readdir provides stats

                if (itemStats.isDirectory()) {
                    await this.copyDirectoryRecursive(sftp, currentSourcePath, currentDestPath);
                } else if (itemStats.isFile()) {
                    await this.copyFile(sftp, currentSourcePath, currentDestPath);
                } else {
                    console.warn(`[SFTP Copy Recurse] Skipping unsupported type: ${currentSourcePath}`);
                }
            }
        } catch (error: any) {
            console.error(`Error recursively copying directory ${sourcePath} to ${destPath}:`, error);
            throw new Error(`递归复制目录失败: ${error.message}`);
        }
    }

     // +++ 辅助方法 - 获取 Stats (Promise wrapper) +++
    private getStats(sftp: SFTPWrapper, path: string): Promise<Stats> {
        return new Promise((resolve, reject) => {
            sftp.lstat(path, (err, stats) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(stats);
                }
            });
        });
    }

    // +++ 修改：辅助方法 - 确保目录存在 (递归创建) +++
    private async ensureDirectoryExists(sftp: SFTPWrapper, dirPath: string): Promise<void> {
        // 规范化路径，移除尾部斜杠（如果存在）
        const normalizedPath = dirPath.replace(/\/$/, '');
        if (!normalizedPath || normalizedPath === '/') {
            return; // 根目录不需要创建
        }

        try {
            // 1. 尝试直接 stat 目录
            await this.getStats(sftp, normalizedPath);
            // console.log(`[SFTP Util] Directory already exists: ${normalizedPath}`);
            return; // 目录已存在
        } catch (statError: any) {
            // 2. 如果 stat 失败，检查是否是 "No such file" 错误
            if (statError.code === 'ENOENT' || (statError.message && statError.message.includes('No such file'))) {
                // 目录不存在，尝试创建
                try {
                    // 3. 尝试递归创建 (ssh2 的 mkdir 支持非标准 recursive 属性)
                    // 注意：这可能不适用于所有 SFTP 服务器
                    await new Promise<void>((resolveMkdir, rejectMkdir) => {
                        // @ts-ignore - ssh2 types might not include 'recursive' in attributes
                        sftp.mkdir(normalizedPath, { recursive: true }, (mkdirErr) => {
                            if (mkdirErr) {
                                // 如果递归创建失败，尝试逐级创建
                                console.warn(`[SFTP Util] Recursive mkdir failed for ${normalizedPath}, falling back to iterative creation:`, mkdirErr);
                                rejectMkdir(mkdirErr); // Reject to trigger fallback
                            } else {
                                console.log(`[SFTP Util] Recursively created directory: ${normalizedPath}`);
                                resolveMkdir();
                            }
                        });
                    });
                    return; // 递归创建成功
                } catch (recursiveMkdirError) {
                    // 4. 递归创建失败，回退到逐级创建
                    const parentDir = pathModule.dirname(normalizedPath).replace(/\\/g, '/');
                    if (parentDir && parentDir !== '/' && parentDir !== '.') {
                        // 递归确保父目录存在
                        await this.ensureDirectoryExists(sftp, parentDir);
                    }
                    // 创建当前目录
                    try {
                        await new Promise<void>((resolveMkdir, rejectMkdir) => {
                             sftp.mkdir(normalizedPath, (mkdirErr) => {
                                if (mkdirErr) {
                                    // 如果逐级创建也失败，则抛出错误
                                    rejectMkdir(new Error(`创建目录失败 ${normalizedPath}: ${mkdirErr.message}`));
                                } else {
                                    console.log(`[SFTP Util] Iteratively created directory: ${normalizedPath}`);
                                    resolveMkdir();
                                }
                            });
                        });
                    } catch (iterativeMkdirError: any) {
                         console.error(`[SFTP Util] Iterative mkdir failed for ${normalizedPath}:`, iterativeMkdirError);
                         // 检查是否是因为目录已存在（可能由并发操作创建）
                         try {
                             const finalStats = await this.getStats(sftp, normalizedPath);
                             if (!finalStats.isDirectory()) {
                                 throw new Error(`路径 ${normalizedPath} 已存在但不是目录`);
                             }
                             // 如果目录现在存在，则忽略错误
                             console.log(`[SFTP Util] Directory ${normalizedPath} exists after iterative mkdir failure, likely created concurrently.`);
                         } catch (finalStatError) {
                             // 如果最终检查也失败，则抛出原始的逐级创建错误
                             throw iterativeMkdirError;
                         }
                    }
                }
            } else {
                // 其他 stat 错误
                throw new Error(`检查目录失败 ${normalizedPath}: ${statError.message}`);
            }
        }
    }

     // +++ 辅助方法 - 列出目录内容 (Promise wrapper) +++
    private listDirectory(sftp: SFTPWrapper, path: string): Promise<SftpDirEntry[]> { // 使用本地接口 SftpDirEntry
        return new Promise((resolve, reject) => {
            sftp.readdir(path, (err, list) => { // list 的类型现在是 SftpDirEntry[]
                if (err) {
                    reject(err);
                } else {
                    resolve(list);
                }
            });
        });
    }

     // +++ 辅助方法 - 执行重命名 (Promise wrapper) +++
    private performRename(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            sftp.rename(oldPath, newPath, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    // +++ 辅助方法 - 格式化 Stats 为 FileListItem +++
    private formatStatsToFileListItem(itemPath: string, stats: Stats): any {
         return {
            filename: pathModule.basename(itemPath),
            longname: '', // stat doesn't provide longname, maybe generate a basic one?
            attrs: {
                size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
            }
        };
    }


    // --- Compress/Decompress Methods ---
/**
     * 压缩远程服务器上的文件/目录
     * @param sessionId 会话 ID
     * @param payload 压缩请求的 payload
     */
    async compress(sessionId: string, payload: SftpCompressRequestPayload): Promise<void> {
        const state = this.clientStates.get(sessionId);
        const { sources, destinationArchiveName, format, targetDirectory, requestId } = payload;

        if (!state || !state.sshClient) {
            console.warn(`[SFTP Compress] SSH 客户端未准备好，无法在 ${sessionId} 上执行 compress (ID: ${requestId})`);
            this.sendCompressError(state?.ws, 'SSH 会话未就绪', requestId);
            return;
        }

        // 命令检查
        const requiredCommand = format === 'zip' ? 'zip' : 'tar';
        try {
            const commandExists = await this.checkCommandExists(state, sessionId, requiredCommand); // 传递 sessionId
            if (!commandExists) {
                this.sendCompressError(state.ws, `命令 '${requiredCommand}' 在服务器上未找到`, requestId, `Command '${requiredCommand}' not found on server.`);
                return;
            }
        } catch (checkError: any) {
            this.sendCompressError(state.ws, `检查命令 '${requiredCommand}' 时出错`, requestId, checkError.message);
            return;
        }

        console.debug(`[SFTP Compress ${sessionId}] Received request (ID: ${requestId}). Sources: ${sources.join(', ')}, Dest: ${destinationArchiveName}, Format: ${format}, Dir: ${targetDirectory}`);

        // 构建目标压缩包的完整路径
        const destinationArchivePath = pathModule.posix.join(targetDirectory, destinationArchiveName);

        // --- 构建 Shell 命令 ---
        let command: string;
        // --- 修改：计算相对路径并引用 ---
        const relativeSources = sources.map((s: string) => {
            // 计算相对于 targetDirectory 的路径
            const relativePath = pathModule.posix.relative(targetDirectory, s);
            // 如果计算出的相对路径为空或'.', 表示源文件就在目标目录下，直接使用文件名
            // 否则使用计算出的相对路径
            return (relativePath === '' || relativePath === '.') ? pathModule.posix.basename(s) : relativePath;
        });
        const quotedRelativeSources = relativeSources.map((s: string) => `"${s.replace(/"/g, '\\"')}"`).join(' ');
        
        // 确保目标目录和压缩包路径被正确引用
        const quotedTargetDir = `"${targetDirectory.replace(/"/g, '\\"')}"`;
        // const quotedDestPath = `"${destinationArchivePath.replace(/"/g, '\\"')}"`; // 目标路径在命令中不直接使用，使用相对名称
        const quotedDestName = `"${destinationArchiveName.replace(/"/g, '\\"')}"`;

        const cdCommand = `cd ${quotedTargetDir}`;

        switch (format) {
            case 'zip':
                // zip -r [归档名] [源文件/目录列表]
                // 需要在目标目录执行
                command = `${cdCommand} && zip -r ${quotedDestName} ${quotedRelativeSources}`; // 使用相对路径
                break;
            case 'targz':
                // tar -czvf [归档名] [源文件/目录列表]
                // 需要在目标目录执行
                command = `${cdCommand} && tar -czvf ${quotedDestName} ${quotedRelativeSources}`; // 使用相对路径
                break;
            case 'tarbz2':
                // tar -cjvf [归档名] [源文件/目录列表]
                // 需要在目标目录执行
                command = `${cdCommand} && tar -cjvf ${quotedDestName} ${quotedRelativeSources}`; // 使用相对路径
                break;
            default:
                this.sendCompressError(state.ws, `不支持的压缩格式: ${format}`, requestId);
                return;
        }

        console.log(`[SFTP Compress ${sessionId}] Executing command: ${command} (ID: ${requestId})`);

        // --- 执行命令 ---
        try {
            state.sshClient.exec(command, (err, stream) => {
                if (err) {
                    console.error(`[SFTP Compress ${sessionId}] Failed to start exec for compress (ID: ${requestId}):`, err);
                    this.sendCompressError(state.ws, `执行压缩命令失败: ${err.message}`, requestId);
                    return;
                }

                let stdoutData = '';
                let stderrData = '';
                let code: number | null = null; // Track exit code

                stream.on('data', (data: Buffer) => {
                    stdoutData += data.toString();
                    // console.debug(`[SFTP Compress ${sessionId}] stdout: ${data.toString()}`);
                });
                stream.stderr.on('data', (data: Buffer) => {
                    stderrData += data.toString();
                    // console.debug(`[SFTP Compress ${sessionId}] stderr: ${data.toString()}`);
                });

                stream.on('close', (exitCode: number | null) => {
                    code = exitCode; // Store exit code
                    console.log(`[SFTP Compress ${sessionId}] Command finished with code ${code} (ID: ${requestId}). Stderr: ${stderrData.trim()}`);
                    if (code === 0 && !this.isErrorInStdErr(stderrData)) { // 检查退出码和 stderr
                        console.log(`[SFTP Compress ${sessionId}] Compression successful (ID: ${requestId}).`);
                        const successPayload: SftpCompressSuccessPayload = {
                            message: '压缩成功',
                            requestId: requestId
                        };
                        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                             state.ws.send(JSON.stringify({ type: 'sftp:compress:success', requestId: requestId, payload: successPayload })); // Ensure requestId is included
                        }
                    } else {
                        const errorDetails = stderrData.trim() || `压缩命令退出，代码: ${code ?? 'N/A'}`;
                        console.error(`[SFTP Compress ${sessionId}] Compression failed (ID: ${requestId}): ${errorDetails}`);
                        this.sendCompressError(state.ws, '压缩失败', requestId, errorDetails);
                    }
                });
                 stream.on('error', (streamErr: Error) => { 
                     console.error(`[SFTP Compress ${sessionId}] Command stream error (ID: ${requestId}):`, streamErr);
                     // 避免重复发送错误
                     if (!stderrData && code === undefined) { // 仅当 close 事件未触发且 stderr 为空时发送
                          this.sendCompressError(state.ws, '压缩命令流错误', requestId, streamErr.message);
                     }
                 });
            });
        } catch (execError: any) {
            console.error(`[SFTP Compress ${sessionId}] Compress command caught unexpected error during exec setup (ID: ${requestId}):`, execError);
            this.sendCompressError(state.ws, `执行压缩时发生意外错误: ${execError.message}`, requestId);
        }
    }

    /**
     * 解压远程服务器上的压缩文件
     * @param sessionId 会话 ID
     * @param payload 解压请求的 payload
     */
    async decompress(sessionId: string, payload: SftpDecompressRequestPayload): Promise<void> {
        const state = this.clientStates.get(sessionId);
        const { archivePath, requestId } = payload;

        if (!state || !state.sshClient) {
            console.warn(`[SFTP Decompress] SSH 客户端未准备好，无法在 ${sessionId} 上执行 decompress (ID: ${requestId})`);
            this.sendDecompressError(state?.ws, 'SSH 会话未就绪', requestId);
            return;
        }

        const lowerArchivePath = archivePath.toLowerCase(); // 在此声明一次

        // 命令检查
        let requiredCommand = '';
        // 使用已经声明的 lowerArchivePath
        if (lowerArchivePath.endsWith('.zip')) {
            requiredCommand = 'unzip';
        } else if (lowerArchivePath.endsWith('.tar.gz') || lowerArchivePath.endsWith('.tgz') || lowerArchivePath.endsWith('.tar.bz2') || lowerArchivePath.endsWith('.tbz2')) {
            requiredCommand = 'tar';
        } else {
            this.sendDecompressError(state.ws, `不支持的压缩文件格式: ${archivePath}`, requestId);
            return;
        }

        try {
            const commandExists = await this.checkCommandExists(state, sessionId, requiredCommand); // 传递 sessionId
            if (!commandExists) {
                this.sendDecompressError(state.ws, `命令 '${requiredCommand}' 在服务器上未找到`, requestId, `Command '${requiredCommand}' not found on server.`);
                return;
            }
        } catch (checkError: any) {
            this.sendDecompressError(state.ws, `检查命令 '${requiredCommand}' 时出错`, requestId, checkError.message);
            return;
        }

        console.debug(`[SFTP Decompress ${sessionId}] Received request for ${archivePath} (ID: ${requestId})`);

        const extractDir = pathModule.posix.dirname(archivePath);
        const archiveBasename = pathModule.posix.basename(archivePath);

        // --- 构建 Shell 命令 ---
        let command: string;
        // 确保路径被正确引用
        const quotedExtractDir = `"${extractDir.replace(/"/g, '\\"')}"`;
        const quotedArchiveBasename = `"${archiveBasename.replace(/"/g, '\\"')}"`;

        const cdCommand = `cd ${quotedExtractDir}`;

        // 使用在方法开始处声明的 lowerArchivePath
        if (lowerArchivePath.endsWith('.zip')) {
            // unzip -o [压缩包名]
            // 需要在目标目录执行
            command = `${cdCommand} && unzip -o ${quotedArchiveBasename}`;
        } else if (lowerArchivePath.endsWith('.tar.gz') || lowerArchivePath.endsWith('.tgz')) {
            // tar -xzvf [压缩包名]
            // 需要在目标目录执行
            command = `${cdCommand} && tar -xzvf ${quotedArchiveBasename}`;
        } else if (lowerArchivePath.endsWith('.tar.bz2') || lowerArchivePath.endsWith('.tbz2')) {
            // tar -xjvf [压缩包名]
            // 需要在目标目录执行
            command = `${cdCommand} && tar -xjvf ${quotedArchiveBasename}`;
        } else {
            this.sendDecompressError(state.ws, `不支持的压缩文件格式: ${archivePath}`, requestId);
            return;
        }

        console.log(`[SFTP Decompress ${sessionId}] Executing command: ${command} (ID: ${requestId})`);

        // --- 执行命令 ---
        try {
            state.sshClient.exec(command, (err, stream) => {
                if (err) {
                    console.error(`[SFTP Decompress ${sessionId}] Failed to start exec for decompress (ID: ${requestId}):`, err);
                    this.sendDecompressError(state.ws, `执行解压命令失败: ${err.message}`, requestId);
                    return;
                }

                let stdoutData = '';
                let stderrData = '';
                let code: number | null = null; // Track exit code

                stream.on('data', (data: Buffer) => {
                    stdoutData += data.toString();
                    // console.debug(`[SFTP Decompress ${sessionId}] stdout: ${data.toString()}`);
                });
                stream.stderr.on('data', (data: Buffer) => {
                    stderrData += data.toString();
                    // console.debug(`[SFTP Decompress ${sessionId}] stderr: ${data.toString()}`);
                });

                stream.on('close', (exitCode: number | null) => {
                     code = exitCode; // Store exit code
                    console.log(`[SFTP Decompress ${sessionId}] Command finished with code ${code} (ID: ${requestId}). Stderr: ${stderrData.trim()}`);
                    if (code === 0 && !this.isErrorInStdErr(stderrData)) { // 检查退出码和 stderr
                        console.log(`[SFTP Decompress ${sessionId}] Decompression successful (ID: ${requestId}).`);
                        const successPayload: SftpDecompressSuccessPayload = {
                            message: '解压成功',
                            requestId: requestId
                        };
                         if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                            state.ws.send(JSON.stringify({ type: 'sftp:decompress:success', requestId: requestId, payload: successPayload })); // Ensure requestId is included
                         }
                    } else {
                        const errorDetails = stderrData.trim() || `解压命令退出，代码: ${code ?? 'N/A'}`;
                        console.error(`[SFTP Decompress ${sessionId}] Decompression failed (ID: ${requestId}): ${errorDetails}`);
                        this.sendDecompressError(state.ws, '解压失败', requestId, errorDetails);
                    }
                });
                 stream.on('error', (streamErr: Error) => {
                     console.error(`[SFTP Decompress ${sessionId}] Command stream error (ID: ${requestId}):`, streamErr);
                     // 避免重复发送错误
                     if (!stderrData && code === undefined) { // 仅当 close 事件未触发且 stderr 为空时发送
                         this.sendDecompressError(state.ws, '解压命令流错误', requestId, streamErr.message);
                     }
                 });
            });
        } catch (execError: any) {
            console.error(`[SFTP Decompress ${sessionId}] Decompress command caught unexpected error during exec setup (ID: ${requestId}):`, execError);
            this.sendDecompressError(state.ws, `执行解压时发生意外错误: ${execError.message}`, requestId);
        }
    }

    // --- 辅助方法 ---

    /** 检查远程服务器上是否存在指定的命令 */
    private checkCommandExists(state: ClientState, sessionId: string, commandName: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if (!state.sshClient) {
                return reject(new Error('SSH client is not available.'));
            }
            // 优先使用 command -v, 其次 which
            const checkCommands = [`command -v ${commandName}`, `which ${commandName}`];
            let currentCheckIndex = 0;

            const tryCommand = () => {
                if (currentCheckIndex >= checkCommands.length) {
                    resolve(false); // 所有检查命令都尝试过了，未找到
                    return;
                }
                const checkCmd = checkCommands[currentCheckIndex];
                console.log(`[SFTP Command Check ${sessionId}] Executing: ${checkCmd}`);
                state.sshClient.exec(checkCmd, (err, stream) => {
                    if (err) {
                        console.error(`[SFTP Command Check ${sessionId}] Failed to start exec for "${checkCmd}":`, err);
                        currentCheckIndex++;
                        tryCommand(); // 尝试下一个检查命令
                        return;
                    }
                    let output = '';
                    stream.on('data', (data: Buffer) => {
                        output += data.toString();
                    });
                    stream.on('close', (code: number | null) => {
                        if (code === 0 && output.trim() !== '') {
                            console.log(`[SFTP Command Check ${sessionId}] Command '${commandName}' found using "${checkCmd}". Output: ${output.trim()}`);
                            resolve(true);
                        } else {
                            console.log(`[SFTP Command Check ${sessionId}] Command '${commandName}' not found with "${checkCmd}" (code: ${code}, output: "${output.trim()}").`);
                            currentCheckIndex++;
                            tryCommand(); // 尝试下一个检查命令
                        }
                    });
                    stream.stderr.on('data', (data: Buffer) => {
                        // console.debug(`[SFTP Command Check ${sessionId}] stderr for "${checkCmd}": ${data.toString()}`);
                    });
                    stream.on('error', (streamErr: Error) => {
                        console.error(`[SFTP Command Check ${sessionId}] Stream error for "${checkCmd}":`, streamErr);
                        currentCheckIndex++;
                        tryCommand(); // 尝试下一个检查命令
                    });
                });
            };
            tryCommand();
        });
    }


    /** 发送压缩错误消息 */
    private sendCompressError(ws: AuthenticatedWebSocket | undefined, error: string, requestId: string, details?: string): void {
         if (ws && ws.readyState === WebSocket.OPEN) {
            const payload: SftpCompressErrorPayload = { error, requestId };
            if (details) payload.details = details;
            // 检查是否是命令未找到的特定错误
            if (error.includes('在服务器上未找到')) {
                 ws.send(JSON.stringify({ type: 'sftp:command_not_found', payload: { operation: 'compress', command: error.match(/'([^']+)'/)?.[1] || 'unknown', message: details || error }, requestId }));
            } else {
                 ws.send(JSON.stringify({ type: 'sftp:compress:error', payload }));
            }
         } else {
             console.warn(`[SFTP Compress] WebSocket closed or invalid, cannot send error for request ${requestId}.`);
         }
    }

    /** 发送解压错误消息 */
    private sendDecompressError(ws: AuthenticatedWebSocket | undefined, error: string, requestId: string, details?: string): void {
         if (ws && ws.readyState === WebSocket.OPEN) {
            const payload: SftpDecompressErrorPayload = { error, requestId };
            if (details) payload.details = details;
            // 检查是否是命令未找到的特定错误
            if (error.includes('在服务器上未找到')) {
                ws.send(JSON.stringify({ type: 'sftp:command_not_found', payload: { operation: 'decompress', command: error.match(/'([^']+)'/)?.[1] || 'unknown', message: details || error }, requestId }));
            } else {
                ws.send(JSON.stringify({ type: 'sftp:decompress:error', payload }));
            }
        } else {
             console.warn(`[SFTP Decompress] WebSocket closed or invalid, cannot send error for request ${requestId}.`);
         }
    }

    /** 检查 stderr 输出是否包含表示错误的常见模式 */
    private isErrorInStdErr(stderr: string): boolean {
        if (!stderr || stderr.trim().length === 0) {
            return false; // 空 stderr 不是错误
        }
        const lowerStderr = stderr.toLowerCase();
        // 常见的错误关键词或模式
        const errorPatterns = [
            'error', 'fail', 'cannot', 'not found', 'no such file', 'permission denied', 'invalid', '不支持'
        ];
        // tar/zip 进度信息通常包含百分比或文件名，不应视为错误
        if (/[\d.]+%/.test(stderr) || /adding:/.test(lowerStderr) || /inflating:/.test(lowerStderr) || /extracting:/.test(lowerStderr)) {
            // 忽略一些明确的非错误输出
            if (errorPatterns.some(pattern => lowerStderr.includes(pattern))) {
                 // 如果进度信息中包含错误关键词，则可能真的是错误
                 return true;
            }
            return false;
        }

        return errorPatterns.some(pattern => lowerStderr.includes(pattern));
    }


    // --- File Upload Methods ---

    /** Start a new file upload */
    async startUpload(sessionId: string, uploadId: string, remotePath: string, totalSize: number, relativePath?: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP Upload ${uploadId}] SFTP not ready for session ${sessionId}.`);
            state?.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: 'SFTP 会话未就绪' } }));
            return;
        }
        if (this.activeUploads.has(uploadId)) {
            console.warn(`[SFTP Upload ${uploadId}] Upload already in progress for session ${sessionId}.`);
            state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: 'Upload already started' } }));
            return;
        }


        try {
            // --- 在创建流之前确保目录存在 ---
            if (relativePath) {
                const targetDirectory = pathModule.dirname(remotePath).replace(/\\/g, '/');
                // console.log(`[SFTP Upload ${uploadId}] Ensuring directory exists: ${targetDirectory}`);
                try {
                    // 确保 state.sftp 存在
                    if (!state.sftp) throw new Error('SFTP session is not available.');
                    await this.ensureDirectoryExists(state.sftp, targetDirectory);
                    // console.log(`[SFTP Upload ${uploadId}] Directory ensured: ${targetDirectory}`);
                } catch (dirError: any) {
                    console.error(`[SFTP Upload ${uploadId}] Failed to create/ensure directory ${targetDirectory}:`, dirError);
                    state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `创建目录失败: ${dirError.message}` } }));
                    // 不再删除 activeUploads，因为可能还没有创建
                    return; 
                }
            }
            
            // --- 预检查文件是否可写 ---
            try {
                // 确保 state.sftp 存在
                if (!state.sftp) throw new Error('SFTP session is not available.');
                await new Promise<void>((resolve, reject) => {
                    // 'w' flag: Open file for writing. The file is created (if it does not exist) or truncated (if it exists).
                    state.sftp!.open(remotePath, 'w', (openErr, handle) => {
                        if (openErr) {
                            // console.error(`[SFTP Upload ${uploadId}] Pre-check failed (sftp.open 'w') for ${remotePath}:`, openErr);
                            return reject(openErr); // Reject if cannot open for writing
                        }
                        // Immediately close the handle, we just wanted to check writability
                        state.sftp!.close(handle, (closeErr) => {
                            if (closeErr) {
                                // Log warning but don't fail the pre-check if closing fails
                                // console.warn(`[SFTP Upload ${uploadId}] Error closing handle during pre-check for ${remotePath}:`, closeErr);
                            }
                            resolve();
                        });
                    });
                });
            } catch (preCheckError: any) {
                 console.error(`[SFTP Upload ${uploadId}] Writability pre-check failed for ${remotePath}:`, preCheckError);
                 state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `文件不可写或创建失败: ${preCheckError.message}` } }));
                 return; // Stop if pre-check fails
            }
            

            // 确保 state.sftp 存在
            if (!state.sftp) throw new Error('SFTP session is not available after pre-check.');
            // +++ 上传替换已有文件时，保留原始权限（避免默认 0o666 覆盖原本的 0o755 等） +++
            let existingMode: number | undefined;
            try {
                const fileStats = await new Promise<Stats>((resolve, reject) => {
                    state.sftp!.stat(remotePath, (statErr, s) => {
                        if (statErr) return reject(statErr);
                        resolve(s);
                    });
                });
                existingMode = fileStats.mode;
            } catch (modeErr) {
                // 文件不存在（新上传），使用默认权限
            }
            const stream = state.sftp.createWriteStream(
                remotePath,
                existingMode !== undefined ? { mode: existingMode } : {}
            );
            const uploadState: ActiveUpload = {
                remotePath,
                totalSize,
                bytesWritten: 0,
                stream,
                sessionId,
                relativePath, // +++ 存储 relativePath +++
                drainPromise: null, // +++ Initialize drainPromise +++
                // +++ 新增字段初始化 +++
                inFlightChunks: 0,
                pendingChunks: new Map(),
                expectedChunkIndex: 0,
                flushLock: null,
                closeTimeoutFallback: null,
                endRequested: false,
            };
            this.activeUploads.set(uploadId, uploadState);

            stream.on('error', (err: Error) => {
                console.error(`[SFTP Upload ${uploadId}] WriteStream 'error' event for ${remotePath}:`, err);
                // +++ 清理 close 兜底定时器 +++
                const errUploadState = this.activeUploads.get(uploadId);
                if (errUploadState?.closeTimeoutFallback) {
                    clearTimeout(errUploadState.closeTimeoutFallback);
                    errUploadState.closeTimeoutFallback = null;
                }
                state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `写入流错误: ${err.message}` } }));
                this.activeUploads.delete(uploadId);
            });

            stream.on('close', () => {
                // +++ 清理 close 兜底定时器 +++
                const closingState = this.activeUploads.get(uploadId);
                if (closingState?.closeTimeoutFallback) {
                    clearTimeout(closingState.closeTimeoutFallback);
                    closingState.closeTimeoutFallback = null;
                }
                const finalState = this.activeUploads.get(uploadId);

                if (finalState) {
                    if (finalState.bytesWritten >= finalState.totalSize) {
                        state.sftp!.lstat(finalState.remotePath, (statErr, stats) => {
                            if (statErr) {
                                console.error(`[SFTP Upload ${uploadId}] lstat after stream close ${finalState.remotePath} failed:`, statErr);
                                state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `获取最终文件状态失败: ${statErr.message}` } }));
                            } else {
                                if (stats.size < finalState.totalSize) {
                                     console.error(`[SFTP Upload ${uploadId}] Final file size (${stats.size}) is less than expected total size (${finalState.totalSize}) after stream close.`);
                                     state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `最终文件大小 (${stats.size}) 小于预期 (${finalState.totalSize})` } }));
                                } else {
                                    const finalStatsPayload = {
                                        filename: finalState.remotePath.substring(finalState.remotePath.lastIndexOf('/') + 1),
                                        longname: '',
                                        attrs: {
                                            size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                                            atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                                            isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                                        }
                                    };
                                    state.ws.send(JSON.stringify({ type: 'sftp:upload:success', payload: finalStatsPayload, uploadId: uploadId, path: finalState.remotePath }));
                                }
                            }
                            this.activeUploads.delete(uploadId);
                        });
                    } else {
                         this.activeUploads.delete(uploadId);
                    }
                }
            });



            // Notify client that we are ready for chunks
            state.ws.send(JSON.stringify({ type: 'sftp:upload:ready', payload: { uploadId } }));

        } catch (error: any) {
            console.error(`[SFTP Upload ${uploadId}] Error starting upload for ${remotePath}:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `开始上传时出错: ${error.message}` } }));
            this.activeUploads.delete(uploadId); // Clean up if start failed
        }
    }

    /** Handle an incoming file chunk */
    async handleUploadChunk(sessionId: string, uploadId: string, chunkIndex: number, dataBase64: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        const uploadState = this.activeUploads.get(uploadId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP Upload ${uploadId}] Received chunk ${chunkIndex}, but session ${sessionId} or SFTP is invalid.`);
            this.cancelUploadInternal(uploadId, 'Session or SFTP invalid');
            return;
        }
        if (!uploadState) {
            console.warn(`[SFTP Upload ${uploadId}] Received chunk ${chunkIndex}, but no active upload found.`);
            return;
        }
        // 滑动窗口硬限制：拒绝超出窗口的块，防止客户端绕过流控导致内存暴涨/卡死
        if (uploadState.inFlightChunks >= UPLOAD_WINDOW_SIZE) {
            console.warn(`[SFTP Upload ${uploadId}] Window full (${uploadState.inFlightChunks}/${UPLOAD_WINDOW_SIZE}), rejecting chunk ${chunkIndex}.`);
            state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: '滑动窗口已满，请等待确认后再发送' } }));
            return;
        }
        try {
            // 全局内存上限检查（base64 解码后约为长度的 3/4）
            const estimatedChunkBytes = Math.ceil((dataBase64.length * 3) / 4);
            if (globalBufferedBytes + estimatedChunkBytes > GLOBAL_UPLOAD_MEMORY_LIMIT) {
                console.warn(`[SFTP Upload ${uploadId}] Global buffer limit reached, rejecting chunk ${chunkIndex}.`);
                state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: '服务器缓冲内存已满，请稍后再试' } }));
                return;
            }
            // 仅在块未重复时计入在途计数；重复块先释放旧 buffer 的内存计数
            const isDuplicate = uploadState.pendingChunks.has(chunkIndex);
            if (!isDuplicate) {
                uploadState.inFlightChunks++;
            } else {
                const old = uploadState.pendingChunks.get(chunkIndex);
                if (old) globalBufferedBytes = Math.max(0, globalBufferedBytes - old.length);
                console.warn(`[SFTP Upload ${uploadId}] Duplicate chunk ${chunkIndex} received, overwriting buffer.`);
            }
            const chunkBuffer = Buffer.from(dataBase64, 'base64');
            globalBufferedBytes += chunkBuffer.length;
            // 存入排序缓冲区，按序刷写到流
            uploadState.pendingChunks.set(chunkIndex, chunkBuffer);
            await this.flushPendingChunks(uploadId);
        } catch (error: any) {
            console.error(`[SFTP Upload ${uploadId}] Error handling chunk ${chunkIndex} for ${uploadState?.remotePath}:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `处理块 ${chunkIndex} 时出错: ${error.message}` } }));
            this.cancelUploadInternal(uploadId, `Error handling chunk ${chunkIndex}`);
        }
    }
    /** 按序刷写待写入块缓冲区，使用 Promise 锁保证不重入 */
    private flushPendingChunks(uploadId: string): Promise<void> {
        const uploadState = this.activeUploads.get(uploadId);
        if (!uploadState) return Promise.resolve();
        // 已有刷写在进行，排队等待其完成后再启动新一轮
        if (uploadState.flushLock) {
            return uploadState.flushLock.then(() => this._doFlushPendingChunks(uploadId));
        }
        const flushPromise = this._doFlushPendingChunks(uploadId);
        uploadState.flushLock = flushPromise;
        flushPromise.finally(() => {
            if (uploadState) uploadState.flushLock = null;
        });
        return flushPromise;
    }
    /** 实际执行按序刷写逻辑 */
    private async _doFlushPendingChunks(uploadId: string): Promise<void> {
        const uploadState = this.activeUploads.get(uploadId);
        if (!uploadState) return;
        const state = this.clientStates.get(uploadState.sessionId);
        if (!state) return;
        try {
            while (uploadState.pendingChunks.has(uploadState.expectedChunkIndex)) {
                const currentIndex = uploadState.expectedChunkIndex;
                const bufferedChunk = uploadState.pendingChunks.get(currentIndex);
                if (!bufferedChunk) break;
                uploadState.pendingChunks.delete(currentIndex);
                // 释放该块的全局缓冲内存计数
                globalBufferedBytes = Math.max(0, globalBufferedBytes - bufferedChunk.length);
                uploadState.expectedChunkIndex++;
                // 按序写入流并等待完成（含背压处理）
                await this.writeChunkToStream(uploadId, bufferedChunk);
                // 写入完成后释放窗口槽位并通知前端
                uploadState.inFlightChunks = Math.max(0, uploadState.inFlightChunks - 1);
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    const progressPercent = uploadState.totalSize === 0
                        ? 100
                        : Math.round((uploadState.bytesWritten / uploadState.totalSize) * 100);
                    state.ws.send(JSON.stringify({
                        type: 'sftp:upload:progress',
                        uploadId,
                        payload: {
                            bytesWritten: uploadState.bytesWritten,
                            totalSize: uploadState.totalSize,
                            progress: Math.min(100, progressPercent)
                        }
                    }));
                    // 发送滑动窗口 ack，告知前端剩余可用槽位
                    const windowSlots = Math.max(0, UPLOAD_WINDOW_SIZE - uploadState.inFlightChunks);
                    state.ws.send(JSON.stringify({
                        type: 'sftp:upload:chunk:ack',
                        uploadId,
                        payload: { chunkIndex: currentIndex, windowSlots }
                    }));
                }
                // 所有字节写入完毕，结束流
                if (uploadState.bytesWritten >= uploadState.totalSize) {
                    if (!uploadState.endRequested && !uploadState.stream.writableEnded) {
                        uploadState.endRequested = true;
                        // 兜底：5 秒内未触发 close 事件则强制销毁流并清理，避免卡死
                        uploadState.closeTimeoutFallback = setTimeout(() => {
                            const pendingState = this.activeUploads.get(uploadId);
                            if (pendingState && !pendingState.stream.destroyed) {
                                console.warn(`[SFTP Upload ${uploadId}] stream close 事件超时(5s)，强制销毁流。`);
                                pendingState.stream.destroy();
                                this.activeUploads.delete(uploadId);
                            }
                        }, 5000);
                        uploadState.stream.end((endErr: Error & { code?: string } | undefined) => {
                            if (endErr) {
                                if (endErr.code === 'ERR_STREAM_DESTROYED' && uploadState.bytesWritten >= uploadState.totalSize) {
                                    console.warn(`[SFTP Upload ${uploadId}] ERR_STREAM_DESTROYED but all bytes written.`);
                                } else {
                                    console.error(`[SFTP Upload ${uploadId}] Error from stream.end():`, endErr);
                                    state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `结束写入流时出错: ${endErr.message}` } }));
                                    this.cancelUploadInternal(uploadId, `Stream end error: ${endErr.message}`);
                                }
                            }
                        });
                    }
                    break;
                }
            }
        } catch (error: any) {
            console.error(`[SFTP Upload ${uploadId}] _doFlushPendingChunks error:`, error);
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `刷写缓冲区时出错: ${error.message}` } }));
            }
            this.cancelUploadInternal(uploadId, `Flush error: ${error.message}`);
        }
    }
    /** 将单个块写入 SFTP 流，处理背压（drain） */
    private writeChunkToStream(uploadId: string, chunkBuffer: Buffer): Promise<void> {
        const uploadState = this.activeUploads.get(uploadId);
        if (!uploadState) return Promise.resolve();
        const state = this.clientStates.get(uploadState.sessionId);
        if (!state) return Promise.resolve();
        return new Promise<void>((resolveWrite, reject) => {
            let settled = false;
            const settle = (action: 'resolve' | 'reject', err?: Error) => {
                if (settled) return;
                settled = true;
                if (action === 'resolve') resolveWrite();
                else reject(err);
            };
            const writeSuccess = uploadState.stream.write(chunkBuffer, (err) => {
                if (err) {
                    console.error(`[SFTP Upload ${uploadId}] Write callback error:`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `写入块失败: ${err.message}` } }));
                    this.cancelUploadInternal(uploadId, 'Write error');
                    settle('reject', err);
                    return;
                }
                uploadState.bytesWritten += chunkBuffer.length;
                if (writeSuccess) {
                    settle('resolve');
                }
                // writeSuccess === false 时等待 drain 后再 resolve
            });
            if (!writeSuccess) {
                if (!uploadState.drainPromise) {
                    uploadState.drainPromise = new Promise<void>(drainResolve => {
                        uploadState.stream.once('drain', () => {
                            uploadState.drainPromise = null;
                            drainResolve();
                        });
                    });
                }
                uploadState.drainPromise.then(() => settle('resolve'));
            }
        });
    }

    /** Cancel an ongoing upload */
    cancelUpload(sessionId: string, uploadId: string): void {
        const state = this.clientStates.get(sessionId);
        const uploadState = this.activeUploads.get(uploadId);

        if (!state) {
            console.warn(`[SFTP Upload ${uploadId}] Request to cancel, but session ${sessionId} not found.`);
            // Can't send message back if session is gone
            this.cancelUploadInternal(uploadId, 'Session not found'); // Clean up if state exists
            return;
        }
        if (!uploadState) {
            console.warn(`[SFTP Upload ${uploadId}] Request to cancel, but no active upload found.`);
            state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: '无效的上传 ID 或上传已取消/完成' } }));
            return;
        }

        console.log(`[SFTP Upload ${uploadId}] Cancelling upload for ${uploadState.remotePath}`);
        this.cancelUploadInternal(uploadId, 'User cancelled');
        state.ws.send(JSON.stringify({ type: 'sftp:upload:cancelled', payload: { uploadId } }));
    }

    /** Internal helper to clean up an upload */
    private cancelUploadInternal(uploadId: string, reason: string, triggeringError?: any): void {
        const uploadState = this.activeUploads.get(uploadId);

        if (uploadState) {
            console.log(`[SFTP Upload ${uploadId}] Cleaning upload state: ${reason}`);
            // +++ 清理 close 兜底定时器 +++
            if (uploadState.closeTimeoutFallback) {
                clearTimeout(uploadState.closeTimeoutFallback);
                uploadState.closeTimeoutFallback = null;
            }
            const currentStream = uploadState.stream;
            if (currentStream && !currentStream.destroyed) {
                if (!currentStream.writableEnded) {
                    currentStream.end((endErr: Error | undefined) => {
                        if (endErr && !currentStream.destroyed) {
                            currentStream.destroy();
                        }
                    });
                } else {
                    currentStream.destroy();
                }
            }
            // +++ 释放待写入块占用的全局缓冲内存，防止内存泄漏 +++
            for (const [, buffered] of uploadState.pendingChunks) {
                globalBufferedBytes = Math.max(0, globalBufferedBytes - buffered.length);
            }
            uploadState.pendingChunks.clear();
            this.activeUploads.delete(uploadId);
        }
    }
}
