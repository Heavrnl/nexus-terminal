import { ClientState } from '../websocket/types';
import { SFTPWrapper } from 'ssh2';
import {
    SftpCompressRequestPayload,
    SftpDecompressRequestPayload
} from '../websocket/types';
import { SftpFileService } from './services/sftp-file.service';
import { SftpTransferService } from './services/sftp-transfer.service';
import { SftpArchiveService } from './services/sftp-archive.service';
import { SftpUploadService } from './services/sftp-upload.service';
import { ScpFileService } from './services/scp-file.service';
import { openSudoSftp } from './services/sudo-sftp';
import { findFullConnectionById } from '../connections/connection.repository';
import { decrypt } from '../utils/crypto';
import { buildChownCommand } from './chown-command';

/**
 * 远程文件服务门面 (SFTP / SCP Facade)
 * 支持原生 SFTP 与兼容 BusyBox/小米路由器/嵌入式设备的 SCP 双轨驱动，
 * 并支持自动探测与无缝降级 (Auto-fallback)。
 */
export class SftpService {
    private clientStates: Map<string, ClientState>;
    private fileService: SftpFileService;
    private transferService: SftpTransferService;
    private archiveService: SftpArchiveService;
    private uploadService: SftpUploadService;
    private scpFileService: ScpFileService;

    constructor(clientStates: Map<string, ClientState>) {
        this.clientStates = clientStates;
        this.fileService = new SftpFileService(this.clientStates);
        this.transferService = new SftpTransferService(this.clientStates);
        this.archiveService = new SftpArchiveService(this.clientStates);
        this.uploadService = new SftpUploadService(this.clientStates);
        this.scpFileService = new ScpFileService(this.clientStates);
    }

    /**
     * 初始化 SFTP/SCP 会话
     * 支持自动探测降级 (Auto) / 强制 SFTP / 强制 SCP
     * @param sessionId 会话 ID
     */
    async initializeSftpSession(sessionId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            console.warn(`[FileProtocol] 无法为会话 ${sessionId} 初始化文件服务：状态无效或 SSH 客户端不存在。`);
            return;
        }

        // 若已初始化就绪，直接发送 sftp_ready
        if (state.sftp || state.activeFileProtocol === 'scp') {
            console.log(`[FileProtocol] 会话 ${sessionId} 已经就绪 (协议: ${state.activeFileProtocol || 'sftp'})。`);
            state.ws.send(JSON.stringify({ type: 'sftp_ready', payload: { connectionId: state.dbConnectionId } }));
            return;
        }

        // 获取连接配置（文件协议 + SFTP sudo 提权）
        let protocolConfig = state.fileProtocolConfig;
        let sudoEnabled = false;
        let sudoPassword: string | undefined;

        if (state.dbConnectionId) {
            try {
                // findFullConnectionById 拿的是 c.*，一次就能拿到 file_protocol 和 sudo 三列
                const row = await findFullConnectionById(state.dbConnectionId);
                if (row) {
                    if (row.file_protocol) {
                        protocolConfig = row.file_protocol;
                        state.fileProtocolConfig = protocolConfig;
                    }
                    sudoEnabled = !!row.sftp_sudo_enabled;
                    if (sudoEnabled && row.encrypted_sudo_password) {
                        try {
                            sudoPassword = decrypt(row.encrypted_sudo_password);
                        } catch (decErr: any) {
                            console.warn(`[FileProtocol] 会话 ${sessionId} 的 sudo 密码解密失败，将尝试免密 sudo:`, decErr?.message || decErr);
                        }
                    }
                }
            } catch (err: any) {
                console.warn(`[FileProtocol] 查询会话 ${sessionId} 的连接配置失败:`, err.message);
            }
        }
        protocolConfig = protocolConfig || 'auto';

        // 1. 若配置为强制 SCP：直接标记就绪
        if (protocolConfig === 'scp') {
            console.log(`[FileProtocol] 会话 ${sessionId} 采用强制 SCP 模式，无需协商 SFTP 子系统。`);
            state.activeFileProtocol = 'scp';
            state.ws.send(JSON.stringify({ type: 'sftp_ready', payload: { connectionId: state.dbConnectionId } }));
            return;
        }

        // 并发防护：若异步初始化期间会话已被清理或 WS 已关闭，静默退出避免空指针异常
        if (!state.sshClient || state.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // 2. 开了 sudo 提权就先试 `sudo sftp-server`。
        //    提权是加分项：失败一定退回普通 SFTP，并把原因带给前端 ——
        //    否则用户只是密码填错，整个文件管理器就都用不了了。
        let sudoFallback: string | undefined;
        if (sudoEnabled) {
            try {
                const sudoSftp = await openSudoSftp(state.sshClient, { password: sudoPassword });
                if (!state.sshClient || state.ws.readyState !== WebSocket.OPEN) {
                    try { sudoSftp.end(); } catch {}
                    return;
                }
                console.log(`[SFTP] 会话 ${sessionId} 已通过 sudo 提权打开 SFTP（读写权限等同 root）。`);
                state.activeFileProtocol = 'sftp';
                state.sftp = sudoSftp;
                state.sudoSftp = true;
                this.bindSftpLifecycle(sessionId, state, sudoSftp);
                state.ws.send(JSON.stringify({
                    type: 'sftp_ready',
                    payload: { connectionId: state.dbConnectionId, sudo: true }
                }));
                return;
            } catch (sudoErr: any) {
                sudoFallback = sudoErr?.message || '未知原因';
                if (!state.sshClient || state.ws.readyState !== WebSocket.OPEN) {
                    return;
                }
                console.warn(`[SFTP] 会话 ${sessionId} sudo 提权失败：${sudoFallback}。退回普通 SFTP。`);
            }
        }

        // 3. 若配置为 'auto' 或 'sftp'：尝试原生 SFTP 协商
        return new Promise<void>((resolve, reject) => {
            if (!state.sshClient || state.ws.readyState !== WebSocket.OPEN) {
                resolve();
                return;
            }
            state.sshClient.sftp((err, sftpInstance) => {
                if (err) {
                    // 若是 auto 模式，捕获到 SFTP 子系统请求失败（如小米路由器等无 openssh-sftp-server 服务），秒级平滑降级为 SCP 驱动！
                    if (protocolConfig === 'auto') {
                        console.warn(`[FileProtocol] 会话 ${sessionId} 原生 SFTP 子系统协商失败 (${err.message})。设备可能未安装 openssh-sftp-server，已自动平滑降级为 SCP 驱动！`);
                        state.activeFileProtocol = 'scp';
                        state.ws.send(JSON.stringify({ 
                            type: 'sftp_ready', 
                            payload: { 
                                connectionId: state.dbConnectionId,
                                protocol: 'scp',
                                fallback: true,
                                ...(sudoFallback ? { sudoFallback } : {}),
                            } 
                        }));
                        resolve();
                        return;
                    }

                    console.error(`[SFTP] 为会话 ${sessionId} 初始化 SFTP 会话失败:`, err);
                    state.ws.send(JSON.stringify({ type: 'sftp_error', payload: { connectionId: state.dbConnectionId, message: 'SFTP 初始化失败' } }));
                    reject(err);
                } else {
                    console.log(`[SFTP] 为会话 ${sessionId} 初始化 SFTP 会话成功。`);
                    state.activeFileProtocol = 'sftp';
                    state.sftp = sftpInstance;
                    state.ws.send(JSON.stringify({
                        type: 'sftp_ready',
                        payload: { connectionId: state.dbConnectionId, ...(sudoFallback ? { sudoFallback } : {}) }
                    }));
                    this.bindSftpLifecycle(sessionId, state, sftpInstance);
                    resolve();
                }
            });
        });
    }

    /**
     * 统一挂 SFTP 通道的生命周期回调：通道一断就把 state.sftp 清掉，
     * 免得后续所有文件操作对着一个已经死掉的通道发请求。
     */
    private bindSftpLifecycle(sessionId: string, state: ClientState, sftpInstance: SFTPWrapper): void {
        sftpInstance.on('end', () => {
            console.log(`[SFTP] 会话 ${sessionId} 的 SFTP 会话已结束。`);
            if (state) {
                state.sftp = undefined;
                state.sudoSftp = false;
            }
        });
        sftpInstance.on('close', () => {
            console.log(`[SFTP] 会话 ${sessionId} 的 SFTP 会话已关闭。`);
            if (state) {
                state.sftp = undefined;
                state.sudoSftp = false;
            }
        });
        sftpInstance.on('error', (sftpErr: Error) => {
            console.error(`[SFTP] 会话 ${sessionId} 的 SFTP 会话出错:`, sftpErr);
            if (state) {
                state.sftp = undefined;
                state.sudoSftp = false;
            }
            state?.ws.send(JSON.stringify({ type: 'sftp_error', payload: { connectionId: state.dbConnectionId, message: 'SFTP 会话错误' } }));
        });
    }

    /**
     * 清理 SFTP/SCP 会话
     * @param sessionId 会话 ID
     */
    cleanupSftpSession(sessionId: string): void {
        const state = this.clientStates.get(sessionId);
        if (state?.sftp) {
            console.log(`[SFTP] 正在清理 ${sessionId} 的 SFTP 会话...`);
            state.sftp.end();
            state.sftp = undefined;
        }
        if (state) {
            state.activeFileProtocol = undefined;
        }
        this.uploadService.cancelSessionUploads(sessionId);
    }

    // --- 基础文件/目录操作委托 (按 activeFileProtocol 分发) ---

    async readdir(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.readdir(sessionId, path, requestId);
        }
        return this.fileService.readdir(sessionId, path, requestId);
    }

    async stat(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.stat(sessionId, path, requestId);
        }
        return this.fileService.stat(sessionId, path, requestId);
    }

    async readFile(sessionId: string, path: string, requestId: string, requestedEncoding?: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.readFile(sessionId, path, requestId, requestedEncoding);
        }
        return this.fileService.readFile(sessionId, path, requestId, requestedEncoding);
    }

    async writefile(sessionId: string, path: string, data: string, requestId: string, encoding?: string, createParents?: boolean): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.writefile(sessionId, path, data, requestId, encoding, createParents);
        }
        return this.fileService.writefile(sessionId, path, data, requestId, encoding, createParents);
    }

    async mkdir(sessionId: string, path: string, requestId: string, createParents?: boolean): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.mkdir(sessionId, path, requestId);
        }
        return this.fileService.mkdir(sessionId, path, requestId, createParents);
    }

    async rmdir(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.rmdir(sessionId, path, requestId);
        }
        return this.fileService.rmdir(sessionId, path, requestId);
    }

    async unlink(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.unlink(sessionId, path, requestId);
        }
        return this.fileService.unlink(sessionId, path, requestId);
    }

    async rename(sessionId: string, oldPath: string, newPath: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.rename(sessionId, oldPath, newPath, requestId);
        }
        return this.fileService.rename(sessionId, oldPath, newPath, requestId);
    }

    async chmod(sessionId: string, path: string, mode: number, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.chmod(sessionId, path, mode, requestId);
        }
        return this.fileService.chmod(sessionId, path, mode, requestId);
    }

    /**
     * 修改文件/目录的所有者与所属组。
     *
     * 走 SSH 执行 `chown` 而不是 SFTP 原生的 `sftp.chown`：协议层的 chown 只接受
     * 数字 uid/gid，而界面里填的是 `www-data` 这类名字，还得额外解析一次。
     * 顺带一个好处是 SFTP / SCP 两种文件模式共用同一份实现。
     */
    async chown(
        sessionId: string,
        path: string,
        targets: { owner?: string; group?: string },
        requestId: string
    ): Promise<void> {
        const state = this.clientStates.get(sessionId);
        const send = (type: 'sftp:chown:success' | 'sftp:chown:error', payload: any) => {
            state?.ws.send(JSON.stringify({ type, path, payload, requestId }));
        };

        if (!state || !state.sshClient) {
            console.warn(`[SFTP] 会话 ${sessionId} 的 SSH 通道不存在，无法执行 chown (ID: ${requestId})`);
            send('sftp:chown:error', 'SSH 会话未就绪');
            return;
        }

        const { command, error } = buildChownCommand(path, targets);
        if (!command) {
            const reasonMap: Record<string, string> = {
                emptyTargets: '没有指定要修改的所有者或所属组',
                invalidOwner: '所有者名称不合法（只允许字母、数字、点、下划线、连字符）',
                invalidGroup: '所属组名称不合法（只允许字母、数字、点、下划线、连字符）',
            };
            console.warn(`[SFTP ${sessionId}] chown 参数校验失败 (ID: ${requestId}):`, error);
            send('sftp:chown:error', reasonMap[error || ''] || '参数不合法');
            return;
        }

        console.debug(`[SFTP ${sessionId}] chown ${path} → ${targets.owner || ''}:${targets.group || ''} (ID: ${requestId})`);

        try {
            const result = await new Promise<{ stderr: string; code: number | null }>((resolve, reject) => {
                if (!state.sshClient) return reject(new Error('SSH client disconnected'));
                let stderr = '';
                let settled = false;
                // 远端卡在 D 状态 / NFS 挂死时 close 永远不来，不能让前端一直转圈
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    reject(new Error('执行超时（15s），远端可能无响应'));
                }, 15000);
                const done = (fn: () => void) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    fn();
                };
                state.sshClient.exec(command, { pty: false }, (err, stream) => {
                    if (err) return done(() => reject(err));
                    // ⚠️ 必须把 stdout 读掉（或 resume）：chown 正常时没有输出，
                    // 但 ssh2 的 channel 是 Readable，处于 paused 模式时 'end'/'close' 不会触发，
                    // 整个 Promise 就永远悬着 —— 前端表现为「一直在改，没有结果」。
                    stream.on('data', () => { /* chown 成功无输出，丢弃 */ });
                    stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                    stream.on('close', (code: number | null) => done(() => resolve({ stderr, code })));
                    stream.on('error', (execErr: Error) => done(() => reject(execErr)));
                });
            });

            if (result.code !== 0) {
                const detail = result.stderr.trim() || `退出码 ${result.code}`;
                console.error(`[SFTP ${sessionId}] chown ${path} 失败 (ID: ${requestId}):`, detail);
                // chown 最常见的失败就是权限不足（普通用户不能把文件送给别人）
                const hint = /operation not permitted|permission denied/i.test(detail)
                    ? '（需要 root 或有 CAP_CHOWN 权限）'
                    : '';
                send('sftp:chown:error', `修改所有者失败: ${detail}${hint}`);
                return;
            }

            // 成功：能 lstat 就顺手把最新属性回给前端，列表里的 uid/gid 立刻跟上
            if (state.sftp) {
                state.sftp.lstat(path, (statErr, stats) => {
                    if (statErr) {
                        send('sftp:chown:success', null);
                        return;
                    }
                    send('sftp:chown:success', {
                        filename: path.substring(path.lastIndexOf('/') + 1),
                        longname: '',
                        attrs: {
                            size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                            atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                            isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                        },
                    });
                });
            } else {
                send('sftp:chown:success', null);
            }
        } catch (err: any) {
            console.error(`[SFTP ${sessionId}] chown ${path} 异常 (ID: ${requestId}):`, err);
            send('sftp:chown:error', `修改所有者时发生异常: ${err?.message || err}`);
        }
    }

    async realpath(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (state?.activeFileProtocol === 'scp') {
            return this.scpFileService.realpath(sessionId, path, requestId);
        }
        return this.fileService.realpath(sessionId, path, requestId);
    }

    // --- 复制与移动操作委托 ---

    async copy(sessionId: string, sources: string[], destinationDir: string, requestId: string): Promise<void> {
        return this.transferService.copy(sessionId, sources, destinationDir, requestId);
    }

    async move(sessionId: string, sources: string[], destinationDir: string, requestId: string): Promise<void> {
        return this.transferService.move(sessionId, sources, destinationDir, requestId);
    }

    // --- 压缩与解压操作委托 ---

    async compress(sessionId: string, payload: SftpCompressRequestPayload): Promise<void> {
        return this.archiveService.compress(sessionId, payload);
    }

    async decompress(sessionId: string, payload: SftpDecompressRequestPayload): Promise<void> {
        return this.archiveService.decompress(sessionId, payload);
    }

    // --- 文件上传操作委托 ---

    async startUpload(sessionId: string, uploadId: string, remotePath: string, totalSize: number, relativePath?: string): Promise<void> {
        return this.uploadService.startUpload(sessionId, uploadId, remotePath, totalSize, relativePath);
    }

    async handleUploadChunk(sessionId: string, uploadId: string, chunkIndex: number, dataBase64: string): Promise<void> {
        return this.uploadService.handleUploadChunk(sessionId, uploadId, chunkIndex, dataBase64);
    }

    cancelUpload(sessionId: string, uploadId: string): void {
        this.uploadService.cancelUpload(sessionId, uploadId);
    }
}
