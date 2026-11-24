import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import { createRemoteSession } from '../remote/remote.controller';
import {
    getRemoteAgentStatus,
    scanConnectionRemoteSessions,
    killConnectionRemoteSession,
    uninstallConnectionRemoteAgent,
} from '../remote-agent/remote-agent.controller';
import {
    createConnection,
    getConnections,
    getConnectionById,
    updateConnection, 
    deleteConnection,
    testConnection,
    testUnsavedConnection,
    cloneConnection, 
    
    addFolderToConnections 
} from './connections.controller';

const router = Router();

// 应用认证中间件到所有 /connections 路由
router.use(isAuthenticated); // 恢复认证检查


// GET /api/v1/connections - 获取连接列表
router.get('/', getConnections);

// POST /api/v1/connections - 创建新连接
router.post('/', createConnection);

// GET /api/v1/connections/remote-agent/status - 获取内置 nexus-mux 托管代理状态（必须位于 /:id 之前）
router.get('/remote-agent/status', getRemoteAgentStatus);

// GET /api/v1/connections/:id - 获取单个连接信息
router.get('/:id', getConnectionById);

// PUT /api/v1/connections/:id - 更新连接信息
router.put('/:id', updateConnection);

// DELETE /api/v1/connections/:id - 删除连接
router.delete('/:id', deleteConnection);

// POST /api/v1/connections/:id/test - 测试连接
router.post('/:id/test', testConnection);

// POST /api/v1/connections/test-unsaved - 测试未保存的连接信息
router.post('/test-unsaved', testUnsavedConnection);

// POST /api/v1/connections/:id/remote-session - 签发一次性远程桌面票据（RDP / VNC 共用）
router.post('/:id/remote-session', createRemoteSession);

// 目标机 SSH 会话托管代理管理接口（孤儿扫描、远程终止、一键卸载）
router.post('/:id/remote-agent/scan', scanConnectionRemoteSessions);
router.delete('/:id/remote-agent/sessions/:remoteSessionId', killConnectionRemoteSession);
router.post('/:id/remote-agent/uninstall', uninstallConnectionRemoteAgent);

// +++ POST /api/v1/connections/:id/clone - 克隆连接 +++
router.post('/:id/clone', cloneConnection);

// +++ POST /api/v1/connections/add-folder - 为多个连接添加一个文件夹 +++
router.post('/add-folder', addFolderToConnections);

// Note: PUT /:id/folders route is removed as the primary flow uses the bulk add endpoint now.
// It could be kept if there's a separate use case for updating a single connection's folders.

export default router;
