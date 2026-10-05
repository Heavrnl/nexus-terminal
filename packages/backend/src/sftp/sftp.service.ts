import { ClientState } from '../websocket/types';
import {
    SftpCompressRequestPayload,
    SftpDecompressRequestPayload
} from '../websocket/types';
import { SftpFileService } from './services/sftp-file.service';
import { SftpTransferService } from './services/sftp-transfer.service';
import { SftpArchiveService } from './services/sftp-archive.service';
import { SftpUploadService } from './services/sftp-upload.service';

/**
 * SFTP 门面服务 (Facade)
 * 将原本 1700+ 行的单体服务解耦拆分为专注于单一职责的子服务：
 * - SftpFileService: 基础文件/目录操作 (readdir, stat, readFile, writefile, mkdir, rmdir, unlink, rename, chmod, realpath)
 * - SftpTransferService: 文件与目录复制/移动 (copy, move 及递归处理)
 * - SftpArchiveService: 远程压缩与解压缩 (compress, decompress)
 * - SftpUploadService: 大文件流式分片上传与背压控制 (startUpload, handleUploadChunk, cancelUpload)
 */
export class SftpService {
    private clientStates: Map<string, ClientState>;
    private fileService: SftpFileService;
    private transferService: SftpTransferService;
    private archiveService: SftpArchiveService;
    private uploadService: SftpUploadService;

    constructor(clientStates: Map<string, ClientState>) {
        this.clientStates = clientStates;
        this.fileService = new SftpFileService(this.clientStates);
        this.transferService = new SftpTransferService(this.clientStates);
        this.archiveService = new SftpArchiveService(this.clientStates);
        this.uploadService = new SftpUploadService(this.clientStates);
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
        if (!state.sshClient) {
            console.error(`[SFTP] 会话 ${sessionId} 的 SSH 客户端不存在，无法初始化 SFTP。`);
            return;
        }
        return new Promise((resolve, reject) => {
            state.sshClient!.sftp((err, sftpInstance) => {
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
        this.uploadService.cancelSessionUploads(sessionId);
    }

    // --- 基础文件/目录操作委托 ---

    async readdir(sessionId: string, path: string, requestId: string): Promise<void> {
        return this.fileService.readdir(sessionId, path, requestId);
    }

    async stat(sessionId: string, path: string, requestId: string): Promise<void> {
        return this.fileService.stat(sessionId, path, requestId);
    }

    async readFile(sessionId: string, path: string, requestId: string, requestedEncoding?: string): Promise<void> {
        return this.fileService.readFile(sessionId, path, requestId, requestedEncoding);
    }

    async writefile(sessionId: string, path: string, data: string, requestId: string, encoding?: string): Promise<void> {
        return this.fileService.writefile(sessionId, path, data, requestId, encoding);
    }

    async mkdir(sessionId: string, path: string, requestId: string): Promise<void> {
        return this.fileService.mkdir(sessionId, path, requestId);
    }

    async rmdir(sessionId: string, path: string, requestId: string): Promise<void> {
        return this.fileService.rmdir(sessionId, path, requestId);
    }

    async unlink(sessionId: string, path: string, requestId: string): Promise<void> {
        return this.fileService.unlink(sessionId, path, requestId);
    }

    async rename(sessionId: string, oldPath: string, newPath: string, requestId: string): Promise<void> {
        return this.fileService.rename(sessionId, oldPath, newPath, requestId);
    }

    async chmod(sessionId: string, path: string, mode: number, requestId: string): Promise<void> {
        return this.fileService.chmod(sessionId, path, mode, requestId);
    }

    async realpath(sessionId: string, path: string, requestId: string): Promise<void> {
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
