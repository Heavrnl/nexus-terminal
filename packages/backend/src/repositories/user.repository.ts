import { getDbInstance, getDb, allDb } from '../database/connection'; // 更新导入

export interface User {
    id: number;
    username: string;
    hashed_password?: string; // 在仓库层面，我们可能不需要总是返回密码
    two_factor_secret?: string | null;
    // created_at 和 updated_at 可以根据需要添加
}

export const userRepository = {
    /**
     * 查找管理员用户。
     * 在单用户应用场景下，假设管理员是数据库中的第一个用户。
     * @returns Promise<User | null> 返回管理员用户对象或 null
     */
    async findAdminUser(): Promise<User | null> {
        console.log('[UserRepository] Attempting to find admin user (first user by ID)...');
        try {
            const db = await getDbInstance();
            const admin = await getDb<User>(db, 'SELECT id, username FROM users ORDER BY id ASC LIMIT 1');
            if (admin) {
                console.log(`[UserRepository] Admin user found: ID=${admin.id}, Username=${admin.username}`);
                return admin;
            } else {
                console.warn('[UserRepository] No users found in the database.');
                return null;
            }
        } catch (error) {
            console.error('[UserRepository] Error finding admin user:', error);
            return null;
        }
    },

    /**
     * 根据用户 ID 查找用户 (可选，如果其他地方需要)
     * @param id 用户 ID
     * @returns Promise<User | null>
     */
    async findById(id: number): Promise<User | null> {
        try {
            const db = await getDbInstance();
            const user = await getDb<User>(db, 'SELECT id, username FROM users WHERE id = ?', [id]);
            return user || null;
        } catch (error) {
            console.error(`[UserRepository] Error finding user by ID ${id}:`, error);
            return null;
        }
    },
    
    /**
     * 根据用户名查找用户 (可选，如果其他地方需要)
     * @param username 用户名
     * @returns Promise<User | null>
     */
    async findByUsername(username: string): Promise<User | null> {
        try {
            const db = await getDbInstance(); // <-- 修正：添加获取 db 实例的调用
            const user = await getDb<User>(db, 'SELECT id, username, hashed_password, two_factor_secret FROM users WHERE username = ?', [username]); // <-- 修正：使用 getDb 并传递 db 实例，参数作为数组传递
            return user || null;
        } catch (error) {
            console.error(`[UserRepository] Error finding user by username ${username}:`, error);
            return null;
        }
    }
};