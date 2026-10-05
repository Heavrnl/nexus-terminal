import { WriteStream } from 'ssh2';
import { WebSocket } from 'ws';
import * as pathModule from 'path';
import { ClientState } from '../../websocket/types';
import { ensureDirectoryExists } from './sftp-helper';

export interface ActiveUpload {
    remotePath: string;
    totalSize: number;
    bytesWritten: number;
    stream: WriteStream;
    sessionId: string;
    relativePath?: string;
    drainPromise?: Promise<void> | null;
    isFinalized?: boolean;
    lastProgressEmitTime?: number;
}

export class SftpUploadService {
    private activeUploads: Map<string, ActiveUpload> = new Map();

    constructor(private clientStates: Map<string, ClientState>) {}

    /** 启动一个新文件的上传 */
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
            if (relativePath) {
                const targetDirectory = pathModule.dirname(remotePath).replace(/\\/g, '/');
                try {
                    if (!state.sftp) throw new Error('SFTP session is not available.');
                    await ensureDirectoryExists(state.sftp, targetDirectory);
                } catch (dirError: any) {
                    console.error(`[SFTP Upload ${uploadId}] Failed to create/ensure directory ${targetDirectory}:`, dirError);
                    state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `创建目录失败: ${dirError.message}` } }));
                    return;
                }
            }

            if (!state.sftp) throw new Error('SFTP session is not available.');
            const stream = state.sftp.createWriteStream(remotePath);
            const uploadState: ActiveUpload = {
                remotePath,
                totalSize,
                bytesWritten: 0,
                stream,
                sessionId,
                relativePath,
                drainPromise: null
            };
            this.activeUploads.set(uploadId, uploadState);

            stream.on('error', (err: Error) => {
                console.error(`[SFTP Upload ${uploadId}] WriteStream 'error' event for ${remotePath}:`, err);
                state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `写入流错误: ${err.message}` } }));
                this.activeUploads.delete(uploadId);
            });

            stream.on('finish', () => {
                this.finalizeUpload(sessionId, uploadId);
            });

            stream.on('close', () => {
                this.finalizeUpload(sessionId, uploadId);
            });

            state.ws.send(JSON.stringify({ type: 'sftp:upload:ready', payload: { uploadId } }));
        } catch (error: any) {
            console.error(`[SFTP Upload ${uploadId}] Error starting upload for ${remotePath}:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `开始上传时出错: ${error.message}` } }));
            this.activeUploads.delete(uploadId);
        }
    }

    /** 终结上传任务并通知前端成功 */
    finalizeUpload(sessionId: string, uploadId: string): void {
        const state = this.clientStates.get(sessionId);
        const uploadState = this.activeUploads.get(uploadId);

        if (!state || !uploadState || uploadState.isFinalized) {
            return;
        }
        uploadState.isFinalized = true;

        if (uploadState.bytesWritten >= uploadState.totalSize) {
            if (!state.sftp) {
                this.activeUploads.delete(uploadId);
                return;
            }
            state.sftp.lstat(uploadState.remotePath, (statErr, stats) => {
                if (statErr) {
                    console.error(`[SFTP Upload ${uploadId}] lstat after stream finalize ${uploadState.remotePath} failed:`, statErr);
                    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                        state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `获取最终文件状态失败: ${statErr.message}` } }));
                    }
                } else {
                    if (stats.size < uploadState.totalSize) {
                        console.error(`[SFTP Upload ${uploadId}] Final file size (${stats.size}) is less than expected total size (${uploadState.totalSize})`);
                        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                            state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `最终文件大小 (${stats.size}) 小于预期 (${uploadState.totalSize})` } }));
                        }
                    } else {
                        const finalStatsPayload = {
                            filename: uploadState.remotePath.substring(uploadState.remotePath.lastIndexOf('/') + 1),
                            longname: '',
                            attrs: {
                                size: stats.size, uid: stats.uid, gid: stats.gid, mode: stats.mode,
                                atime: stats.atime * 1000, mtime: stats.mtime * 1000,
                                isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(),
                            }
                        };
                        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                            state.ws.send(JSON.stringify({ type: 'sftp:upload:success', payload: finalStatsPayload, uploadId: uploadId, path: uploadState.remotePath }));
                        }
                    }
                }
                this.activeUploads.delete(uploadId);
            });
        } else {
            this.activeUploads.delete(uploadId);
        }
    }

    /** 处理接收到的文件分片，提供 ACK 背压支持与进度节流 */
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

        try {
            const chunkBuffer = Buffer.from(dataBase64, 'base64');

            await new Promise<void>((resolve, reject) => {
                const writeOk = uploadState.stream.write(chunkBuffer, (err) => {
                    if (err) {
                        return reject(err);
                    }
                    uploadState.bytesWritten += chunkBuffer.length;
                    resolve();
                });

                if (!writeOk) {
                    uploadState.stream.once('drain', () => {
                        resolve();
                    });
                }
            });

            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'sftp:upload:ack',
                    payload: {
                        uploadId,
                        chunkIndex,
                        bytesWritten: uploadState.bytesWritten,
                        totalSize: uploadState.totalSize
                    }
                }));
            }

            const now = Date.now();
            if (!uploadState.lastProgressEmitTime || now - uploadState.lastProgressEmitTime > 250 || uploadState.bytesWritten >= uploadState.totalSize) {
                uploadState.lastProgressEmitTime = now;
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    const progressPercent = Math.min(100, Math.round((uploadState.bytesWritten / uploadState.totalSize) * 100));
                    state.ws.send(JSON.stringify({
                        type: 'sftp:upload:progress',
                        uploadId: uploadId,
                        payload: {
                            bytesWritten: uploadState.bytesWritten,
                            totalSize: uploadState.totalSize,
                            progress: progressPercent
                        }
                    }));
                }
            }

            if (uploadState.bytesWritten >= uploadState.totalSize) {
                if (!uploadState.stream.writableEnded) {
                    uploadState.stream.end((endErr: any) => {
                        if (endErr) {
                            if (endErr.code === 'ERR_STREAM_DESTROYED' || uploadState.bytesWritten >= uploadState.totalSize) {
                                console.warn(`[SFTP Upload ${uploadId}] stream.end() reported ${endErr.code || endErr.message} after all bytes written, proceeding to finalize.`);
                                this.finalizeUpload(sessionId, uploadId);
                            } else {
                                console.error(`[SFTP Upload ${uploadId}] Error from stream.end() CALLBACK for ${uploadState?.remotePath}:`, endErr);
                                if (state && state.ws && state.ws.readyState === WebSocket.OPEN) {
                                    state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `结束写入流时出错: ${endErr.message}` } }));
                                }
                                this.cancelUploadInternal(uploadId, `Stream end error: ${endErr.message}`, endErr);
                            }
                        } else {
                            setTimeout(() => {
                                if (this.activeUploads.has(uploadId)) {
                                    this.finalizeUpload(sessionId, uploadId);
                                }
                            }, 1500);
                        }
                    });
                }
            }
        } catch (error: any) {
            console.error(`[SFTP Upload ${uploadId}] Error handling chunk ${chunkIndex} for ${uploadState?.remotePath}:`, error);
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'sftp:upload:error', payload: { uploadId, message: `处理块 ${chunkIndex} 时出错: ${error.message}` } }));
            }
            this.cancelUploadInternal(uploadId, `Error handling chunk ${chunkIndex}`);
        }
    }

    /** 取消指定上传 */
    cancelUpload(sessionId: string, uploadId: string): void {
        const state = this.clientStates.get(sessionId);
        const uploadState = this.activeUploads.get(uploadId);

        if (!state) {
            console.warn(`[SFTP Upload ${uploadId}] Request to cancel, but session ${sessionId} not found.`);
            this.cancelUploadInternal(uploadId, 'Session not found');
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

    /** 清理特定 session 下的所有活跃上传任务 */
    cancelSessionUploads(sessionId: string, reason: string = 'SFTP session ended'): void {
        this.activeUploads.forEach((upload, uploadId) => {
            if (upload.sessionId === sessionId) {
                console.warn(`[SFTP Upload] Cleaning up active upload ${uploadId} for session ${sessionId}: ${reason}`);
                this.cancelUploadInternal(uploadId, reason);
            }
        });
    }

    /** 内部流清理逻辑 */
    private cancelUploadInternal(uploadId: string, reason: string, triggeringError?: any): void {
        const uploadState = this.activeUploads.get(uploadId);
        if (uploadState) {
            const currentStream = uploadState.stream;
            if (currentStream && !currentStream.destroyed) {
                if (!currentStream.writableEnded) {
                    currentStream.end((endErr: Error | undefined) => {
                        if (endErr) {
                            console.error(`[SFTP Upload ${uploadId}] cancelUploadInternal: Error from stream.end() in cancel:`, endErr, `Original reason for cancel: ${reason}`);
                            if (!currentStream.destroyed) {
                                currentStream.destroy();
                            }
                        }
                    });
                } else {
                    currentStream.destroy();
                }
            }
            this.activeUploads.delete(uploadId);
        }
    }
}
