import { SFTPWrapper } from 'ssh2';
import * as pathModule from 'path';
import { ClientState } from '../../websocket/types';
import {
    ensureDirectoryExists,
    getStats,
    listDirectory,
    performRename,
    formatStatsToFileListItem
} from './sftp-helper';

export class SftpTransferService {
    constructor(private clientStates: Map<string, ClientState>) {}

    /** 复制文件或目录 */
    async copy(sessionId: string, sources: string[], destinationDir: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sftp) {
            console.warn(`[SFTP Copy] SFTP 未准备好，无法在 ${sessionId} 上执行 copy (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:copy:error', payload: 'SFTP 会话未就绪', requestId: requestId }));
            return;
        }
        const sftp = state.sftp;
        console.debug(`[SFTP ${sessionId}] Received copy request (ID: ${requestId}) Sources: ${sources.join(', ')}, Dest: ${destinationDir}`);

        const copiedItemsDetails: any[] = [];
        let firstError: Error | null = null;

        try {
            try {
                await ensureDirectoryExists(sftp, destinationDir);
            } catch (ensureErr: any) {
                console.error(`[SFTP ${sessionId}] Failed to ensure destination directory ${destinationDir} exists (ID: ${requestId}):`, ensureErr);
                throw new Error(`无法创建或访问目标目录: ${ensureErr.message}`);
            }

            for (const sourcePath of sources) {
                const sourceName = pathModule.basename(sourcePath);
                const destPath = pathModule.join(destinationDir, sourceName).replace(/\\/g, '/');

                if (sourcePath === destPath) {
                    console.warn(`[SFTP ${sessionId}] Skipping copy: source and destination are the same (${sourcePath}) (ID: ${requestId})`);
                    continue;
                }

                try {
                    const stats = await getStats(sftp, sourcePath);
                    if (stats.isDirectory()) {
                        console.log(`[SFTP ${sessionId}] Copying directory ${sourcePath} to ${destPath} (ID: ${requestId})`);
                        await this.copyDirectoryRecursive(sftp, sourcePath, destPath);
                    } else if (stats.isFile()) {
                        console.log(`[SFTP ${sessionId}] Copying file ${sourcePath} to ${destPath} (ID: ${requestId})`);
                        await this.copyFile(sftp, sourcePath, destPath);
                    } else {
                        console.warn(`[SFTP ${sessionId}] Skipping copy of unsupported file type: ${sourcePath} (ID: ${requestId})`);
                        continue;
                    }
                    const copiedStats = await getStats(sftp, destPath);
                    copiedItemsDetails.push(formatStatsToFileListItem(destPath, copiedStats));
                } catch (copyErr: any) {
                    console.error(`[SFTP ${sessionId}] Error copying ${sourcePath} to ${destPath} (ID: ${requestId}):`, copyErr);
                    firstError = copyErr;
                    break;
                }
            }

            if (firstError) {
                throw firstError;
            }

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

    /** 移动文件或目录 */
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
            try {
                await ensureDirectoryExists(sftp, destinationDir);
            } catch (ensureErr: any) {
                console.error(`[SFTP ${sessionId}] Failed to ensure destination directory ${destinationDir} exists for move (ID: ${requestId}):`, ensureErr);
                throw new Error(`无法创建或访问目标目录: ${ensureErr.message}`);
            }

            for (const oldPath of sources) {
                const sourceName = pathModule.basename(oldPath);
                const newPath = pathModule.join(destinationDir, sourceName).replace(/\\/g, '/');

                if (oldPath === newPath) {
                    console.warn(`[SFTP ${sessionId}] Skipping move: source and destination are the same (${oldPath}) (ID: ${requestId})`);
                    continue;
                }

                try {
                    let targetExists = false;
                    try {
                        await getStats(sftp, newPath);
                        targetExists = true;
                    } catch (statErr: any) {
                        if (!(statErr.code === 'ENOENT' || (statErr.message && statErr.message.includes('No such file')))) {
                            throw new Error(`检查目标路径 ${newPath} 状态时出错: ${statErr.message}`);
                        }
                    }

                    if (targetExists) {
                        console.error(`[SFTP ${sessionId}] Move failed: Target path ${newPath} already exists (ID: ${requestId})`);
                        throw new Error(`目标路径 ${pathModule.basename(newPath)} 已存在`);
                    }

                    console.log(`[SFTP ${sessionId}] Moving ${oldPath} to ${newPath} (ID: ${requestId})`);
                    await performRename(sftp, oldPath, newPath);

                    const movedStats = await getStats(sftp, newPath);
                    movedItemsDetails.push(formatStatsToFileListItem(newPath, movedStats));
                } catch (moveErr: any) {
                    console.error(`[SFTP ${sessionId}] Error moving ${oldPath} to ${newPath} (ID: ${requestId}):`, moveErr);
                    firstError = moveErr;
                    break;
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

    /** 辅助方法 - 复制单个文件 */
    private copyFile(sftp: SFTPWrapper, sourcePath: string, destPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const readStream = sftp.createReadStream(sourcePath);
            const writeStream = sftp.createWriteStream(destPath);
            let errorOccurred = false;

            const onError = (err: Error) => {
                if (errorOccurred) return;
                errorOccurred = true;
                readStream.destroy();
                writeStream.destroy();
                console.error(`Error copying file ${sourcePath} to ${destPath}:`, err);
                reject(new Error(`复制文件失败: ${err.message}`));
            };

            readStream.on('error', onError);
            writeStream.on('error', onError);

            writeStream.on('close', () => {
                if (!errorOccurred) {
                    resolve();
                }
            });

            readStream.pipe(writeStream);
        });
    }

    /** 辅助方法 - 递归复制目录 */
    private async copyDirectoryRecursive(sftp: SFTPWrapper, sourcePath: string, destPath: string): Promise<void> {
        try {
            await ensureDirectoryExists(sftp, destPath);
            const items = await listDirectory(sftp, sourcePath);

            for (const item of items) {
                const currentSourcePath = pathModule.join(sourcePath, item.filename).replace(/\\/g, '/');
                const currentDestPath = pathModule.join(destPath, item.filename).replace(/\\/g, '/');
                const itemStats = item.attrs;

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
}
