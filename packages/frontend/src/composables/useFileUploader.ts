import { ref, reactive, nextTick, onUnmounted, readonly, type Ref, watchEffect } from 'vue';
import { createWebSocketConnectionManager } from './useWebSocketConnection'; 
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types'; 
import type { UploadItem } from '../types/upload.types'; 
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types'; 


import type { WebSocketDependencies } from './useSftpActions'; 


// +++ 滑动窗口大小：与后端 UPLOAD_WINDOW_SIZE 保持一致，限制同时在途的块数量，防止大文件上传卡死 +++
const UPLOAD_WINDOW_SIZE = 8;
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

    // --- 上传逻辑 ---

    const sendFileChunks = (uploadId: string, file: File, startByte = 0) => {
        const upload = uploads[uploadId];
        if (!wsDeps.value.isConnected.value || !upload || upload.status !== 'uploading') {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Cannot send chunk for ${uploadId}. Connection: ${wsDeps.value.isConnected.value}, Upload status: ${upload?.status}`);
            return;
        }

        const chunkSize = 1024 * 64; // 64KB 块大小
        const reader = new FileReader();
        let offset = startByte;
        let chunkIndex = 0;
        let currentChunkSize = 0;
        let inFlight = 0;       // 已发送但未收到 ack 的块数量
        let reading = false;    // FileReader 是否正在读取（防止并发读取）
        let finished = false;   // 是否已发送最后一块

        const maybeReadNext = () => {
            if (finished || reading) return;
            if (!wsDeps.value.isConnected.value || uploads[uploadId]?.status !== 'uploading') return;
            if (inFlight >= UPLOAD_WINDOW_SIZE) return; // 窗口已满，等待 ack
            if (offset >= file.size) return;            // 没有更多数据
            reading = true;
            const slice = file.slice(offset, offset + chunkSize);
            currentChunkSize = slice.size;
            reader.readAsDataURL(slice);
        };

        // 注册滑动窗口 ack 监听：后端每写完一块回 ack，释放窗口槽位后再继续发送
        const unregisterAck = wsDeps.value.onMessage('sftp:upload:chunk:ack', (payload: MessagePayload, message: WebSocketMessage) => {
            const ackUploadId = message.uploadId || (payload as any)?.uploadId;
            if (ackUploadId !== uploadId) return;
            inFlight = Math.max(0, inFlight - 1);
            maybeReadNext();
        });
        // 保存注销函数，便于上传结束/取消时清理监听器
        (upload as any)._unregisterAck = unregisterAck;

        reader.onload = (e) => {
            reading = false;
            const currentUpload = uploads[uploadId];
            if (!wsDeps.value.isConnected.value || !currentUpload || currentUpload.status !== 'uploading') {
                return;
            }

            const chunkResult = e.target?.result as string;
            if (typeof chunkResult === 'string' && chunkResult.startsWith('data:')) {
                const chunkBase64 = chunkResult.split(',')[1];
                const isLast = offset + chunkSize >= file.size;

                wsDeps.value.sendMessage({
                    type: 'sftp:upload:chunk',
                    payload: { uploadId, chunkIndex: chunkIndex++, data: chunkBase64, isLast }
                });

                inFlight++;
                offset += currentChunkSize;

                if (isLast) {
                    finished = true;
                    console.log(`[FileUploader ${sessionIdForLog.value}] Sent last chunk for ${uploadId}`);
                } else {
                    // 继续在窗口允许范围内读取下一块
                    maybeReadNext();
                }
            } else {
                console.error(`[FileUploader ${sessionIdForLog.value}] FileReader returned unexpected result for ${uploadId}:`, chunkResult);
                currentUpload.status = 'error';
                currentUpload.error = t('fileManager.errors.readFileError');
            }
        };

        reader.onerror = () => {
            reading = false;
            console.error(`[FileUploader ${sessionIdForLog.value}] FileReader error for upload ID: ${uploadId}`);
            const failedUpload = uploads[uploadId];
            if (failedUpload) {
                failedUpload.status = 'error';
                failedUpload.error = t('fileManager.errors.readFileError');
            }
        };

        if (file.size > 0) {
            maybeReadNext();
        } else {
            // 立即处理零字节文件
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

            // +++ 清理滑动窗口 ack 监听器 +++
            const u = upload as any;
            if (u._unregisterAck) { u._unregisterAck(); u._unregisterAck = undefined; }

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

    const onUploadSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        const upload = uploads[uploadId];
        if (upload) {
            console.log(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} successful.`);
            upload.status = 'success';
            upload.progress = 100;

            // +++ 清理滑动窗口 ack 监听器 +++
            const u = upload as any;
            if (u._unregisterAck) { u._unregisterAck(); u._unregisterAck = undefined; }

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

        const upload = uploads[uploadId];
        if (upload) {
            const errorMessage = typeof payload === 'string' ? payload : t('fileManager.errors.uploadFailed');
            console.error(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} error:`, errorMessage);
            upload.status = 'error';
            upload.error = errorMessage; // 使用 payload 作为错误消息

            // +++ 清理滑动窗口 ack 监听器 +++
            const u = upload as any;
            if (u._unregisterAck) { u._unregisterAck(); u._unregisterAck = undefined; }

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
        const upload = uploads[uploadId];
        if (upload) {
            // 状态可能已经由用户操作设置为 'cancelled'
            if (upload.status !== 'cancelled') {
                 upload.status = 'cancelled';
            }
            // +++ 清理滑动窗口 ack 监听器 +++
            const u = upload as any;
            if (u._unregisterAck) { u._unregisterAck(); u._unregisterAck = undefined; }
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
        const unregisterUploadSuccess = wsDeps.value.onMessage('sftp:upload:success', onUploadSuccess);
        const unregisterUploadError = wsDeps.value.onMessage('sftp:upload:error', onUploadError);
        const unregisterUploadPause = wsDeps.value.onMessage('sftp:upload:pause', onUploadPause);
        const unregisterUploadResume = wsDeps.value.onMessage('sftp:upload:resume', onUploadResume);
        const unregisterUploadCancelled = wsDeps.value.onMessage('sftp:upload:cancelled', onUploadCancelled);
        const unregisterUploadProgress = wsDeps.value.onMessage('sftp:upload:progress', onUploadProgress);

        onCleanup(() => {
            unregisterUploadReady?.();
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
        // 注意：消息监听器的注销现在主要由 watchEffect 的 onCleanup 处理。
        // onUnmounted 仍然负责取消正在进行的上传。

        // 当使用此 composable 的组件卸载时，取消任何正在进行的上传
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
