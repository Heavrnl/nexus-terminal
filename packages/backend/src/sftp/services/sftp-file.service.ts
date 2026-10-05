import { Stats } from 'ssh2';
import { ClientState } from '../../websocket/types';
import * as jschardet from 'jschardet';
import * as iconv from 'iconv-lite';

export class SftpFileService {
    constructor(private clientStates: Map<string, ClientState>) {}

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
            state?.ws.send(JSON.stringify({ type: 'sftp:stat:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
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
                let encodingUsed: string = 'utf-8';
                let decodedContent: string = '';
                let decodeError: string | null = null;

                try {
                    if (requestedEncoding) {
                        encodingUsed = requestedEncoding;
                        console.log(`[SFTP ${sessionId}] Using requested encoding: ${encodingUsed} (ID: ${requestId})`);
                        const normalizedEncoding = encodingUsed.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (iconv.encodingExists(normalizedEncoding)) {
                            decodedContent = iconv.decode(fileData, normalizedEncoding);
                            encodingUsed = normalizedEncoding;
                        } else {
                            console.warn(`[SFTP ${sessionId}] Requested encoding "${requestedEncoding}" is not supported by iconv-lite. Falling back to UTF-8. (ID: ${requestId})`);
                            encodingUsed = 'utf-8';
                            decodedContent = iconv.decode(fileData, encodingUsed);
                        }
                    } else {
                        console.log(`[SFTP ${sessionId}] Detecting encoding for ${path} (ID: ${requestId})`);
                        const detection = jschardet.detect(fileData);
                        const detectedEncodingRaw = detection.encoding ? detection.encoding.toLowerCase() : 'utf-8';
                        const confidence = detection.confidence || 0;
                        console.log(`[SFTP ${sessionId}] Detected encoding: ${detectedEncodingRaw} (confidence: ${confidence})`);

                        const chineseEncodings = ['gbk', 'gb2312', 'gb18030', 'big5', 'euc-tw'];
                        let normalizedDetected = detectedEncodingRaw.replace(/[^a-z0-9]/g, '');
                        if (normalizedDetected === 'windows1252') normalizedDetected = 'cp1252';
                        else if (normalizedDetected === 'gb2312') normalizedDetected = 'gbk';

                        if (normalizedDetected === 'utf8' || normalizedDetected === 'ascii') {
                            encodingUsed = 'utf-8';
                            decodedContent = fileData.toString('utf8');
                            console.log(`[SFTP ${sessionId}] Decoded ${path} as UTF-8/ASCII.`);
                        } else if (chineseEncodings.includes(normalizedDetected)) {
                            encodingUsed = 'gb18030';
                            decodedContent = iconv.decode(fileData, encodingUsed);
                            console.log(`[SFTP ${sessionId}] Decoded ${path} from detected Chinese encoding (${normalizedDetected}) as ${encodingUsed}.`);
                        } else if (confidence < 0.90) {
                            console.warn(`[SFTP ${sessionId}] Low confidence detection (${normalizedDetected}, ${confidence}) for ${path}. Attempting GB18030 decode first.`);
                            try {
                                const tempContent = iconv.decode(fileData, 'gb18030');
                                if (tempContent.includes('\uFFFD')) {
                                    console.warn(`[SFTP ${sessionId}] GB18030 decoding resulted in replacement characters. Falling back to original detection (${normalizedDetected}) or UTF-8.`);
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
                                    encodingUsed = 'gb18030';
                                    decodedContent = tempContent;
                                    console.log(`[SFTP ${sessionId}] Decoded ${path} as ${encodingUsed} due to low confidence detection.`);
                                }
                            } catch (gbkError) {
                                console.warn(`[SFTP ${sessionId}] Error decoding as GB18030, falling back to original detection (${normalizedDetected}) or UTF-8:`, gbkError);
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
                            encodingUsed = normalizedDetected;
                            decodedContent = iconv.decode(fileData, encodingUsed);
                            console.log(`[SFTP ${sessionId}] Decoded ${path} from ${encodingUsed} using iconv-lite (high confidence).`);
                        } else {
                            console.warn(`[SFTP ${sessionId}] Unsupported or unknown encoding detected for ${path}: ${normalizedDetected}. Falling back to UTF-8.`);
                            encodingUsed = 'utf-8';
                            decodedContent = fileData.toString('utf8');
                        }
                    }

                    if (decodedContent.includes('\uFFFD')) {
                        console.warn(`[SFTP ${sessionId}] Final decoded content for ${path} (using ${encodingUsed}) contains replacement characters (U+FFFD). Decoding might be incorrect. (ID: ${requestId})`);
                    }
                } catch (err: any) {
                    console.error(`[SFTP ${sessionId}] Error detecting/decoding file content for ${path} (ID: ${requestId}):`, err);
                    decodeError = `文件编码检测或转换失败: ${err.message}`;
                    state.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path: path, payload: decodeError, requestId: requestId }));
                    return;
                }

                console.log(`[SFTP ${sessionId}] Sending raw content (Base64) and encoding used (${encodingUsed}) for ${path} (ID: ${requestId})`);
                state.ws.send(JSON.stringify({
                    type: 'sftp:readfile:success',
                    path: path,
                    payload: {
                        rawContentBase64: fileData.toString('base64'),
                        encodingUsed: encodingUsed
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
    async writefile(sessionId: string, path: string, data: string, requestId: string, encoding?: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 writefile (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
            return;
        }
        const targetEncoding = encoding || 'utf-8';
        console.debug(`[SFTP ${sessionId}] Received writefile request for ${path} (ID: ${requestId}, Encoding: ${targetEncoding})`);
        try {
            let buffer: Buffer;
            try {
                buffer = iconv.encode(data, targetEncoding);
                console.log(`[SFTP ${sessionId}] Encoded content for ${path} using ${targetEncoding} (Buffer size: ${buffer.length})`);
            } catch (encodeError: any) {
                console.error(`[SFTP ${sessionId}] Failed to encode content for ${path} with encoding ${targetEncoding} (ID: ${requestId}):`, encodeError);
                state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: path, payload: `无效的编码或编码失败: ${targetEncoding}`, requestId: requestId }));
                return;
            }

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
            }

            console.debug(`[SFTP ${sessionId}] Creating write stream for ${path} (ID: ${requestId})`);
            const writeStreamOptions = originalMode !== undefined ? { mode: originalMode } : {};
            const writeStream = state.sftp.createWriteStream(path, writeStreamOptions);
            let errorOccurred = false;

            writeStream.on('error', (err: Error) => {
                if (errorOccurred) return;
                errorOccurred = true;
                console.error(`[SFTP ${sessionId}] writefile ${path} stream error (ID: ${requestId}):`, err);
                state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: path, payload: `写入文件流错误: ${err.message}`, requestId: requestId }));
            });

            writeStream.on('close', () => {
                if (!errorOccurred) {
                    console.log(`[SFTP ${sessionId}] writefile ${path} stream closed successfully (ID: ${requestId}). Fetching updated stats...`);
                    if (originalMode !== undefined) {
                        console.log(`[SFTP ${sessionId}] Set file mode for ${path} during creation: ${originalMode.toString(8)} (ID: ${requestId})`);
                    }
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
            writeStream.end(buffer);
            console.debug(`[SFTP ${sessionId}] writefile ${path} end() called (ID: ${requestId})`);
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
            state?.ws.send(JSON.stringify({ type: 'sftp:mkdir:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
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
                    state.sftp!.lstat(path, (statErr, stats) => {
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] lstat after mkdir ${path} failed (ID: ${requestId}):`, statErr);
                            state.ws.send(JSON.stringify({ type: 'sftp:mkdir:success', path: path, payload: null, requestId: requestId }));
                        } else {
                            const newItem = {
                                filename: path.substring(path.lastIndexOf('/') + 1),
                                longname: '',
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
                            tryRmRfCommand(true);
                        } else {
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
                                console.log(`[SSH Exec ${sessionId}] 普通 rm -rf 失败，错误: ${errorMessage}。尝试 sudo rm -rf。`);
                                tryRmRfCommand(true);
                            } else {
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
                    console.log(`[SSH Exec ${sessionId}] 普通 rm -rf 发生意外错误。尝试 sudo rm -rf。`);
                    tryRmRfCommand(true);
                } else {
                    state.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path: path, payload: `删除目录失败: ${attemptDescription} 执行时发生意外错误: ${error.message}`, requestId: requestId }));
                }
            }
        };

        tryRmRfCommand(false);
    }

    /** 删除文件 */
    async unlink(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP] SFTP 未准备好，无法在 ${sessionId} 上执行 unlink (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:unlink:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
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
                    state.ws.send(JSON.stringify({ type: 'sftp:unlink:success', path: path, requestId: requestId }));
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
            state?.ws.send(JSON.stringify({ type: 'sftp:rename:error', oldPath: oldPath, newPath: newPath, payload: 'SFTP 会话未就绪', requestId: requestId }));
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
                    state.sftp!.lstat(newPath, (statErr, stats) => {
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] lstat after rename ${newPath} failed (ID: ${requestId}):`, statErr);
                            state.ws.send(JSON.stringify({ type: 'sftp:rename:success', payload: { oldPath: oldPath, newPath: newPath, newItem: null }, requestId: requestId }));
                        } else {
                            const newItem = {
                                filename: newPath.substring(newPath.lastIndexOf('/') + 1),
                                longname: '',
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
            state?.ws.send(JSON.stringify({ type: 'sftp:chmod:error', path: path, payload: 'SFTP 会话未就绪', requestId: requestId }));
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
                    state.sftp!.lstat(path, (statErr, stats) => {
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] lstat after chmod ${path} failed (ID: ${requestId}):`, statErr);
                            state.ws.send(JSON.stringify({ type: 'sftp:chmod:success', path: path, payload: null, requestId: requestId }));
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
                    const currentState = this.clientStates.get(sessionId);
                    if (!currentState || !currentState.sftp) {
                        console.warn(`[SFTP ${sessionId}] SFTP session for ${absPath} became invalid before stat call (ID: ${requestId}).`);
                        state.ws.send(JSON.stringify({
                            type: 'sftp:realpath:error',
                            path: path,
                            payload: {
                                requestedPath: path,
                                absolutePath: absPath,
                                error: 'SFTP 会话在获取目标类型前已失效'
                            },
                            requestId: requestId
                        }));
                        return;
                    }
                    currentState.sftp.stat(absPath, (statErr, stats) => {
                        if (statErr) {
                            console.error(`[SFTP ${sessionId}] stat on realpath target ${absPath} failed (ID: ${requestId}):`, statErr);
                            state.ws.send(JSON.stringify({
                                type: 'sftp:realpath:error',
                                path: path,
                                payload: {
                                    requestedPath: path,
                                    absolutePath: absPath,
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
                                path: path,
                                payload: {
                                    requestedPath: path,
                                    absolutePath: absPath,
                                    targetType: targetType
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
}
