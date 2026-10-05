import { WebSocket } from 'ws';
import * as pathModule from 'path';
import {
    ClientState,
    AuthenticatedWebSocket,
    SftpCompressRequestPayload,
    SftpCompressSuccessPayload,
    SftpCompressErrorPayload,
    SftpDecompressRequestPayload,
    SftpDecompressSuccessPayload,
    SftpDecompressErrorPayload
} from '../../websocket/types';

export class SftpArchiveService {
    constructor(private clientStates: Map<string, ClientState>) {}

    /**
     * 压缩远程服务器上的文件/目录
     * @param sessionId 会话 ID
     * @param payload 压缩请求载荷
     */
    async compress(sessionId: string, payload: SftpCompressRequestPayload): Promise<void> {
        const state = this.clientStates.get(sessionId);
        const { sources, destinationArchiveName, format, targetDirectory, requestId } = payload;

        if (!state || !state.sshClient) {
            console.warn(`[SFTP Compress] SSH 客户端未准备好，无法在 ${sessionId} 上执行 compress (ID: ${requestId})`);
            this.sendCompressError(state?.ws, 'SSH 会话未就绪', requestId);
            return;
        }

        const requiredCommand = format === 'zip' ? 'zip' : 'tar';
        try {
            const commandExists = await this.checkCommandExists(state, sessionId, requiredCommand);
            if (!commandExists) {
                this.sendCompressError(state.ws, `命令 '${requiredCommand}' 在服务器上未找到`, requestId, `Command '${requiredCommand}' not found on server.`);
                return;
            }
        } catch (checkError: any) {
            this.sendCompressError(state.ws, `检查命令 '${requiredCommand}' 时出错`, requestId, checkError.message);
            return;
        }

        console.debug(`[SFTP Compress ${sessionId}] Received request (ID: ${requestId}). Sources: ${sources.join(', ')}, Dest: ${destinationArchiveName}, Format: ${format}, Dir: ${targetDirectory}`);

        const relativeSources = sources.map((s: string) => {
            const relativePath = pathModule.posix.relative(targetDirectory, s);
            return (relativePath === '' || relativePath === '.') ? pathModule.posix.basename(s) : relativePath;
        });
        const quotedRelativeSources = relativeSources.map((s: string) => `"${s.replace(/"/g, '\\"')}"`).join(' ');
        const quotedTargetDir = `"${targetDirectory.replace(/"/g, '\\"')}"`;
        const quotedDestName = `"${destinationArchiveName.replace(/"/g, '\\"')}"`;

        const cdCommand = `cd ${quotedTargetDir}`;
        let command: string;

        switch (format) {
            case 'zip':
                command = `${cdCommand} && zip -r ${quotedDestName} ${quotedRelativeSources}`;
                break;
            case 'targz':
                command = `${cdCommand} && tar -czvf ${quotedDestName} ${quotedRelativeSources}`;
                break;
            case 'tarbz2':
                command = `${cdCommand} && tar -cjvf ${quotedDestName} ${quotedRelativeSources}`;
                break;
            default:
                this.sendCompressError(state.ws, `不支持的压缩格式: ${format}`, requestId);
                return;
        }

        console.log(`[SFTP Compress ${sessionId}] Executing command: ${command} (ID: ${requestId})`);

        try {
            state.sshClient.exec(command, (err, stream) => {
                if (err) {
                    console.error(`[SFTP Compress ${sessionId}] Failed to start exec for compress (ID: ${requestId}):`, err);
                    this.sendCompressError(state.ws, `执行压缩命令失败: ${err.message}`, requestId);
                    return;
                }

                let stdoutData = '';
                let stderrData = '';
                let code: number | null = null;

                stream.on('data', (data: Buffer) => {
                    stdoutData += data.toString();
                });
                stream.stderr.on('data', (data: Buffer) => {
                    stderrData += data.toString();
                });

                stream.on('close', (exitCode: number | null) => {
                    code = exitCode;
                    console.log(`[SFTP Compress ${sessionId}] Command finished with code ${code} (ID: ${requestId}). Stderr: ${stderrData.trim()}`);
                    if (code === 0 && !this.isErrorInStdErr(stderrData)) {
                        console.log(`[SFTP Compress ${sessionId}] Compression successful (ID: ${requestId}).`);
                        const successPayload: SftpCompressSuccessPayload = {
                            message: '压缩成功',
                            requestId: requestId
                        };
                        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                            state.ws.send(JSON.stringify({ type: 'sftp:compress:success', requestId: requestId, payload: successPayload }));
                        }
                    } else {
                        const errorDetails = stderrData.trim() || `压缩命令退出，代码: ${code ?? 'N/A'}`;
                        console.error(`[SFTP Compress ${sessionId}] Compression failed (ID: ${requestId}): ${errorDetails}`);
                        this.sendCompressError(state.ws, '压缩失败', requestId, errorDetails);
                    }
                });

                stream.on('error', (streamErr: Error) => {
                    console.error(`[SFTP Compress ${sessionId}] Command stream error (ID: ${requestId}):`, streamErr);
                    if (!stderrData && code === undefined) {
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
     * @param payload 解压请求载荷
     */
    async decompress(sessionId: string, payload: SftpDecompressRequestPayload): Promise<void> {
        const state = this.clientStates.get(sessionId);
        const { archivePath, requestId } = payload;

        if (!state || !state.sshClient) {
            console.warn(`[SFTP Decompress] SSH 客户端未准备好，无法在 ${sessionId} 上执行 decompress (ID: ${requestId})`);
            this.sendDecompressError(state?.ws, 'SSH 会话未就绪', requestId);
            return;
        }

        const lowerArchivePath = archivePath.toLowerCase();

        let requiredCommand = '';
        if (lowerArchivePath.endsWith('.zip')) {
            requiredCommand = 'unzip';
        } else if (lowerArchivePath.endsWith('.tar.gz') || lowerArchivePath.endsWith('.tgz') || lowerArchivePath.endsWith('.tar.bz2') || lowerArchivePath.endsWith('.tbz2')) {
            requiredCommand = 'tar';
        } else {
            this.sendDecompressError(state.ws, `不支持的压缩文件格式: ${archivePath}`, requestId);
            return;
        }

        try {
            const commandExists = await this.checkCommandExists(state, sessionId, requiredCommand);
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
        const quotedExtractDir = `"${extractDir.replace(/"/g, '\\"')}"`;
        const quotedArchiveBasename = `"${archiveBasename.replace(/"/g, '\\"')}"`;
        const cdCommand = `cd ${quotedExtractDir}`;

        let command: string;
        if (lowerArchivePath.endsWith('.zip')) {
            command = `${cdCommand} && unzip -o ${quotedArchiveBasename}`;
        } else if (lowerArchivePath.endsWith('.tar.gz') || lowerArchivePath.endsWith('.tgz')) {
            command = `${cdCommand} && tar -xzvf ${quotedArchiveBasename}`;
        } else if (lowerArchivePath.endsWith('.tar.bz2') || lowerArchivePath.endsWith('.tbz2')) {
            command = `${cdCommand} && tar -xjvf ${quotedArchiveBasename}`;
        } else {
            this.sendDecompressError(state.ws, `不支持的压缩文件格式: ${archivePath}`, requestId);
            return;
        }

        console.log(`[SFTP Decompress ${sessionId}] Executing command: ${command} (ID: ${requestId})`);

        try {
            state.sshClient.exec(command, (err, stream) => {
                if (err) {
                    console.error(`[SFTP Decompress ${sessionId}] Failed to start exec for decompress (ID: ${requestId}):`, err);
                    this.sendDecompressError(state.ws, `执行解压命令失败: ${err.message}`, requestId);
                    return;
                }

                let stdoutData = '';
                let stderrData = '';
                let code: number | null = null;

                stream.on('data', (data: Buffer) => {
                    stdoutData += data.toString();
                });
                stream.stderr.on('data', (data: Buffer) => {
                    stderrData += data.toString();
                });

                stream.on('close', (exitCode: number | null) => {
                    code = exitCode;
                    console.log(`[SFTP Decompress ${sessionId}] Command finished with code ${code} (ID: ${requestId}). Stderr: ${stderrData.trim()}`);
                    if (code === 0 && !this.isErrorInStdErr(stderrData)) {
                        console.log(`[SFTP Decompress ${sessionId}] Decompression successful (ID: ${requestId}).`);
                        const successPayload: SftpDecompressSuccessPayload = {
                            message: '解压成功',
                            requestId: requestId
                        };
                        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                            state.ws.send(JSON.stringify({ type: 'sftp:decompress:success', requestId: requestId, payload: successPayload }));
                        }
                    } else {
                        const errorDetails = stderrData.trim() || `解压命令退出，代码: ${code ?? 'N/A'}`;
                        console.error(`[SFTP Decompress ${sessionId}] Decompression failed (ID: ${requestId}): ${errorDetails}`);
                        this.sendDecompressError(state.ws, '解压失败', requestId, errorDetails);
                    }
                });

                stream.on('error', (streamErr: Error) => {
                    console.error(`[SFTP Decompress ${sessionId}] Command stream error (ID: ${requestId}):`, streamErr);
                    if (!stderrData && code === undefined) {
                        this.sendDecompressError(state.ws, '解压命令流错误', requestId, streamErr.message);
                    }
                });
            });
        } catch (execError: any) {
            console.error(`[SFTP Decompress ${sessionId}] Decompress command caught unexpected error during exec setup (ID: ${requestId}):`, execError);
            this.sendDecompressError(state.ws, `执行解压时发生意外错误: ${execError.message}`, requestId);
        }
    }

    /** 检查远程服务器上是否存在指定的命令 */
    private checkCommandExists(state: ClientState, sessionId: string, commandName: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if (!state.sshClient) {
                return reject(new Error('SSH client is not available.'));
            }
            const checkCommands = [`command -v ${commandName}`, `which ${commandName}`];
            let currentCheckIndex = 0;

            const tryCommand = () => {
                if (currentCheckIndex >= checkCommands.length) {
                    resolve(false);
                    return;
                }
                const checkCmd = checkCommands[currentCheckIndex];
                console.log(`[SFTP Command Check ${sessionId}] Executing: ${checkCmd}`);
                state.sshClient!.exec(checkCmd, (err, stream) => {
                    if (err) {
                        console.error(`[SFTP Command Check ${sessionId}] Failed to start exec for "${checkCmd}":`, err);
                        currentCheckIndex++;
                        tryCommand();
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
                            tryCommand();
                        }
                    });
                    stream.on('error', (streamErr: Error) => {
                        console.error(`[SFTP Command Check ${sessionId}] Stream error for "${checkCmd}":`, streamErr);
                        currentCheckIndex++;
                        tryCommand();
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
            return false;
        }
        const lowerStderr = stderr.toLowerCase();
        const errorPatterns = [
            'error', 'fail', 'cannot', 'not found', 'no such file', 'permission denied', 'invalid', '不支持'
        ];
        if (/[\d.]+%/.test(stderr) || /adding:/.test(lowerStderr) || /inflating:/.test(lowerStderr) || /extracting:/.test(lowerStderr)) {
            if (errorPatterns.some(pattern => lowerStderr.includes(pattern))) {
                return true;
            }
            return false;
        }

        return errorPatterns.some(pattern => lowerStderr.includes(pattern));
    }
}
