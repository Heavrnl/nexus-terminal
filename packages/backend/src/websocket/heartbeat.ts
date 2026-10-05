import WebSocket, { WebSocketServer } from 'ws';
import { AuthenticatedWebSocket } from './types';
import { cleanupClientConnection } from './utils';

const HEARTBEAT_INTERVAL_MS = 15000; // 优化心跳检测间隔为 15 秒，避免高负载与文件上传时误杀连接

export function initializeHeartbeat(wss: WebSocketServer): NodeJS.Timeout {
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws: WebSocket) => {
            const extWs = ws as AuthenticatedWebSocket & { missedPongs?: number };
            if (extWs.isAlive === false) {
                extWs.missedPongs = (extWs.missedPongs || 0) + 1;
                if (extWs.missedPongs >= 2) {
                    console.log(`WebSocket 心跳检测：用户 ${extWs.username} (会话: ${extWs.sessionId}) 连续 2 次无响应 (超过 30s)，正在终止连接...`);
                    cleanupClientConnection(extWs.sessionId); // 使用会话 ID 清理
                    return extWs.terminate();
                }
            } else {
                extWs.missedPongs = 0;
            }
            extWs.isAlive = false;
            extWs.ping(() => {});
        });
    }, HEARTBEAT_INTERVAL_MS);

    // 当 WebSocket 服务器关闭时，清除心跳定时器
    wss.on('close', () => {
        console.log('WebSocket 服务器正在关闭，清理心跳定时器...');
        clearInterval(heartbeatInterval);
    });

    console.log(`心跳检测已初始化，间隔: ${HEARTBEAT_INTERVAL_MS}ms`);
    return heartbeatInterval;
}