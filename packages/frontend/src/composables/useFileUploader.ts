import { ref, reactive, nextTick, onUnmounted, readonly, type Ref, watchEffect } from 'vue';
import { createWebSocketConnectionManager } from './useWebSocketConnection'; 
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types'; 
import type { UploadItem } from '../types/upload.types'; 
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types'; 


import type { WebSocketDependencies } from './useSftpActions'; 


const generateUploadId = (): string => {
    return `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};


const joinPath = (base: string, name: string): string => {
    if (base === '/') return `/${name}`;
    if (base.endsWith('/')) return `${base}${name}`;
    return `${base}/${name}`;
};

export function useFileUploader(
    sessionIdForLog: Ref<string>,
    currentPathRef: Ref<string>,
    fileListRef: Readonly<Ref<readonly FileListItem[]>>, // 使用 Readonly 类型
    wsDeps: Ref<WebSocketDependencies> 
) {
    const { t } = useI18n();
wsDeps;

    // 对 uploads 字典使用 reactive 以获得更好的深度响应性
    const uploads = reactive<Record<string, UploadItem>>({});

    // 上传流控控制器映射
    interface UploadController {
        file: File;
        offset: number;
        chunkIndex: number;
        chunkSize: number;
        waitingForAck: boolean;
        ackTimeoutTimer: any;
        readNextChunk: () => void;
        onAck: (payload: any) => void;
        cleanup: () => void;
    }
    const uploadControllers = new Map<string, UploadController>();

    // --- 上传逻辑 ---

    const sendFileChunks = (uploadId: string, file: File, startByte = 0) => {
        const upload = uploads[uploadId];
        // 在继续之前检查连接和上传状态
        if (!wsDeps.value.isConnected.value || !upload || upload.status !== 'uploading') { 
            console.warn(`[FileUploader ${sessionIdForLog.value}] Cannot send chunk for ${uploadId}. Connection: ${wsDeps.value.isConnected.value}, Upload status: ${upload?.status}`);
            return;
        }

        // 提升单块大小至 128KB，兼顾吞吐量与极低内存占用
        const chunkSize = 1024 * 128;
        const reader = new FileReader();
        let offset = startByte;
        let chunkIndex = 0;
        let currentChunkSize = 0;

        // 若已有旧控制器先做清理
        uploadControllers.get(uploadId)?.cleanup();

        const ctrl: UploadController = {
            file,
            offset,
            chunkIndex,
            chunkSize,
            waitingForAck: false,
            ackTimeoutTimer: null,
            readNextChunk: () => {},
            onAck: () => {},
            cleanup: () => {
                if (ctrl.ackTimeoutTimer) {
                    clearTimeout(ctrl.ackTimeoutTimer);
                    ctrl.ackTimeoutTimer = null;
                }
                uploadControllers.delete(uploadId);
            }
        };

        const readNextChunk = () => {
            const currentUpload = uploads[uploadId];
            if (!wsDeps.value.isConnected.value || !currentUpload || currentUpload.status !== 'uploading') {
                return;
            }
            if (offset < file.size) {
                const slice = file.slice(offset, offset + chunkSize);
                currentChunkSize = slice.size;
                reader.readAsDataURL(slice);
            }
        };
        ctrl.readNextChunk = readNextChunk;

        reader.onload = (e) => {
            const currentUpload = uploads[uploadId];
            if (!wsDeps.value.isConnected.value || !currentUpload || currentUpload.status !== 'uploading') { 
                console.warn(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} status changed or disconnected before sending chunk.`);
                ctrl.cleanup();
                return;
            }

            const chunkResult = e.target?.result as string;
            if (typeof chunkResult === 'string' && chunkResult.startsWith('data:')) {
                const chunkBase64 = chunkResult.split(',')[1];
                const isLast = offset + currentChunkSize >= file.size;

                // 发送当前分片
                wsDeps.value.sendMessage({ 
                    type: 'sftp:upload:chunk',
                    payload: { uploadId, chunkIndex, data: chunkBase64, isLast }
                });

                ctrl.waitingForAck = true;

                // 设置 30 秒 ACK 超时保护，防止极端网络挂起
                if (ctrl.ackTimeoutTimer) clearTimeout(ctrl.ackTimeoutTimer);
                ctrl.ackTimeoutTimer = setTimeout(() => {
                    if (ctrl.waitingForAck && uploads[uploadId]?.status === 'uploading') {
                        console.error(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} timed out waiting for ACK on chunk ${chunkIndex}`);
                        uploads[uploadId].status = 'error';
                        uploads[uploadId].error = t('fileManager.errors.uploadFailed') + ' (ACK Timeout)';
                        ctrl.cleanup();
                    }
                }, 30000);

                offset += currentChunkSize;
                chunkIndex++;
                ctrl.offset = offset;
                ctrl.chunkIndex = chunkIndex;

                if (isLast) {
                    console.log(`[FileUploader ${sessionIdForLog.value}] Sent all chunks for ${uploadId}, awaiting finalize.`);
                }
            } else {
                console.error(`[FileUploader ${sessionIdForLog.value}] FileReader returned unexpected result for ${uploadId}:`, chunkResult);
                currentUpload.status = 'error';
                currentUpload.error = t('fileManager.errors.readFileError');
                ctrl.cleanup();
            }
        };

        reader.onerror = () => {
            console.error(`[FileUploader ${sessionIdForLog.value}] FileReader error for upload ID: ${uploadId}`);
            const failedUpload = uploads[uploadId];
            if (failedUpload) {
                failedUpload.status = 'error';
                failedUpload.error = t('fileManager.errors.readFileError');
            }
            ctrl.cleanup();
        };

        // 响应服务端 ACK 确认驱动下一块传输
        ctrl.onAck = (ackPayload: any) => {
            if (ctrl.ackTimeoutTimer) {
                clearTimeout(ctrl.ackTimeoutTimer);
                ctrl.ackTimeoutTimer = null;
            }
            ctrl.waitingForAck = false;

            const currentUpload = uploads[uploadId];
            if (!currentUpload || currentUpload.status !== 'uploading') {
                ctrl.cleanup();
                return;
            }

            // 使用后端确认的实际写入字节更新进度
            if (typeof ackPayload?.bytesWritten === 'number') {
                currentUpload.progress = Math.min(100, Math.round((ackPayload.bytesWritten / file.size) * 100));
            }

            // 若尚未读完，则读取并发送下一块（背压流控核心机制）
            if (offset < file.size) {
                readNextChunk();
            }
        };

        uploadControllers.set(uploadId, ctrl);

        // 开始读取第一个块
        if (file.size > 0) {
            readNextChunk();
        } else {
            console.log(`[FileUploader ${sessionIdForLog.value}] Processing zero-byte file ${uploadId}`);
            wsDeps.value.sendMessage({ type: 'sftp:upload:chunk', payload: { uploadId, chunkIndex: 0, data: '', isLast: true } });
            upload.progress = 100;
        }
    };


    const startFileUpload = (file: File, relativePath?: string) => {
        // Roo: 使用 .value 访问响应式的 sessionIdForLog
        if (!wsDeps.value.isConnected.value) { 
            console.warn(`[FileUploader ${sessionIdForLog.value}] Cannot start upload: WebSocket not connected.`);
            
            return;
        }

        const uploadId = generateUploadId();
        
        let finalRemotePath: string;
        if (relativePath) {
            
            const basePath = currentPathRef.value.endsWith('/') ? currentPathRef.value : `${currentPathRef.value}/`;
            // 确保 relativePath 开头没有斜杠，末尾有斜杠 (如果非空)
            let cleanRelativePath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
            // 移除末尾斜杠（如果有），因为文件名会加上
            cleanRelativePath = cleanRelativePath.endsWith('/') ? cleanRelativePath.slice(0, -1) : cleanRelativePath;
            // 拼接路径，确保 cleanRelativePath 和 file.name 之间只有一个斜杠
            finalRemotePath = `${basePath}${cleanRelativePath ? cleanRelativePath + '/' : ''}${file.name}`;
        } else {
            finalRemotePath = joinPath(currentPathRef.value, file.name); // 对于非文件夹上传，保持原样
        }
        // 规范化路径，移除多余的斜杠 e.g. /root//dir -> /root/dir
        finalRemotePath = finalRemotePath.replace(/\/+/g, '/');
        console.log(`[FileUploader ${sessionIdForLog.value}] Calculated finalRemotePath: ${finalRemotePath} (current: ${currentPathRef.value}, relative: ${relativePath}, filename: ${file.name}) // wsDeps.isSftpReady: ${wsDeps.value.isSftpReady.value}`); 
        // --- 结束修正 ---


        // 添加到响应式 uploads 字典
        uploads[uploadId] = {
            id: uploadId,
            file,
            filename: file.name,
            progress: 0,
            status: 'pending' // 初始状态
        };

        console.log(`[FileUploader ${sessionIdForLog.value}] Starting upload ${uploadId} to ${finalRemotePath}`);
        wsDeps.value.sendMessage({ 
            type: 'sftp:upload:start',
            payload: { uploadId, remotePath: finalRemotePath, size: file.size, relativePath: relativePath || undefined }
        });
        // 后端应该响应 sftp:upload:ready
    };

    const cancelUpload = (uploadId: string, notifyBackend = true) => {
        const upload = uploads[uploadId];
        if (upload && ['pending', 'uploading', 'paused'].includes(upload.status)) {
            console.log(`[FileUploader ${sessionIdForLog.value}] Cancelling upload ${uploadId}`);
            upload.status = 'cancelled'; // 立即更新状态

            // 清理流控控制器与定时器
            uploadControllers.get(uploadId)?.cleanup();

            if (notifyBackend && wsDeps.value.isConnected.value) { 
                wsDeps.value.sendMessage({ type: 'sftp:upload:cancel', payload: { uploadId } }); 
            }

            // 短暂延迟后从列表中移除，以显示取消状态
            setTimeout(() => {
                if (uploads[uploadId]?.status === 'cancelled') {
                    delete uploads[uploadId];
                }
            }, 3000);
        }
    };

    // --- 消息处理器 ---

    const onUploadReady = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        const upload = uploads[uploadId];
        if (upload && upload.status === 'pending') {
            console.log(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} ready, starting chunk sending.`);
            upload.status = 'uploading';
            sendFileChunks(uploadId, upload.file); // 开始发送块
        } else {
             console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:ready for unknown or non-pending upload ID: ${uploadId}`);
        }
    };

    // +++ 核心：处理服务端分片 ACK 确认 +++
    const onUploadAck = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        const ctrl = uploadControllers.get(uploadId);
        if (ctrl) {
            ctrl.onAck(payload);
        }
    };

    const onUploadSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        // 清理流控控制器
        uploadControllers.get(uploadId)?.cleanup();

        const upload = uploads[uploadId];
        if (upload) {
            console.log(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} successful.`);
            upload.status = 'success';
            upload.progress = 100;

            // 立即删除记录
            if (uploads[uploadId]) { // 确保记录仍然存在
                delete uploads[uploadId];
            }

        } else {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:success for unknown upload ID: ${uploadId}`);
        }
    };

    const onUploadError = (payload: MessagePayload, message: WebSocketMessage) => {
        // 从 message 中获取 uploadId，因为 payload 此时是错误字符串
        const uploadId = message.uploadId;
        if (!uploadId) {
             console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:error with missing uploadId:`, message);
             return;
        }

        // 清理流控控制器
        uploadControllers.get(uploadId)?.cleanup();

        const upload = uploads[uploadId];
        if (upload) {
            const errorMessage = typeof payload === 'string' ? payload : t('fileManager.errors.uploadFailed');
            console.error(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} error:`, errorMessage);
            upload.status = 'error';
            upload.error = errorMessage; // 使用 payload 作为错误消息

            // 让错误消息可见时间长一些
            setTimeout(() => {
                if (uploads[uploadId]?.status === 'error') {
                    delete uploads[uploadId];
                }
            }, 5000);
        } else {
             console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:error for unknown upload ID: ${uploadId}`);
        }
    };

    const onUploadPause = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;
        const upload = uploads[uploadId];
        if (upload && upload.status === 'uploading') {
            console.log(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} paused.`);
            upload.status = 'paused';
        }
    };

    const onUploadResume = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;
        const upload = uploads[uploadId];
        if (upload && upload.status === 'paused') {
            console.log(`[FileUploader ${sessionIdForLog.value}] Resuming upload ${uploadId}`);
            upload.status = 'uploading';
            sendFileChunks(uploadId, upload.file);
        }
    };

     const onUploadCancelled = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        uploadControllers.get(uploadId)?.cleanup();

        const upload = uploads[uploadId];
        if (upload) {
            // 状态可能已经由用户操作设置为 'cancelled'
            if (upload.status !== 'cancelled') {
                 upload.status = 'cancelled';
            }
            // 确保它会被移除（如果尚未计划移除）
            setTimeout(() => {
                if (uploads[uploadId]?.status === 'cancelled') {
                    delete uploads[uploadId];
                }
            }, 3000);
        }
    };

    // +++ 处理上传进度更新 +++
    const onUploadProgress = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId; // 从顶层获取 uploadId
        if (!uploadId) {
            return;
        }

        const upload = uploads[uploadId];
        if (upload && upload.status === 'uploading') {
            // payload 现在应该包含 bytesWritten 和 totalSize
            if (typeof payload?.bytesWritten === 'number' && typeof payload?.totalSize === 'number') {
                upload.progress = Math.min(100, Math.round((payload.bytesWritten / payload.totalSize) * 100));
                
            } else {
                console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:progress with incorrect payload format:`, payload);
            }
        } else if (upload) {
            
        } else {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:progress for unknown upload ID: ${uploadId}`);
        }
    };
    

    // --- 动态注册和注销处理器 ---
    watchEffect((onCleanup) => {
        // 当 wsDeps.value 变化时，此 effect 会重新运行
        if (!wsDeps.value || !wsDeps.value.onMessage) {
            console.warn(`[FileUploader ${sessionIdForLog.value}] wsDeps.value or wsDeps.value.onMessage is not available for registering listeners.`);
            return;
        }

        const unregisterUploadReady = wsDeps.value.onMessage('sftp:upload:ready', onUploadReady);
        const unregisterUploadAck = wsDeps.value.onMessage('sftp:upload:ack', onUploadAck);
        const unregisterUploadSuccess = wsDeps.value.onMessage('sftp:upload:success', onUploadSuccess);
        const unregisterUploadError = wsDeps.value.onMessage('sftp:upload:error', onUploadError);
        const unregisterUploadPause = wsDeps.value.onMessage('sftp:upload:pause', onUploadPause);
        const unregisterUploadResume = wsDeps.value.onMessage('sftp:upload:resume', onUploadResume);
        const unregisterUploadCancelled = wsDeps.value.onMessage('sftp:upload:cancelled', onUploadCancelled);
        const unregisterUploadProgress = wsDeps.value.onMessage('sftp:upload:progress', onUploadProgress);

        onCleanup(() => {
            unregisterUploadReady?.();
            unregisterUploadAck?.();
            unregisterUploadSuccess?.();
            unregisterUploadError?.();
            unregisterUploadPause?.();
            unregisterUploadResume?.();
            unregisterUploadCancelled?.();
            unregisterUploadProgress?.();
        });
    });

    // --- 清理 (onUnmounted 仍然用于组件生命周期结束时的清理) ---
    onUnmounted(() => {
        // 当使用此 composable 的组件卸载时，取消任何正在进行的上传并清理所有流控
        uploadControllers.forEach(ctrl => ctrl.cleanup());
        uploadControllers.clear();

        Object.keys(uploads).forEach(uploadId => {
            cancelUpload(uploadId, true); // 卸载时通知后端
        });
    });

    return {
        uploads, 
        startFileUpload,
        cancelUpload,
    };
}
