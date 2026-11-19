
import sqlite3, { OPEN_READWRITE, OPEN_CREATE } from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { tableDefinitions } from './schema.registry';
import { runMigrations, normalizeLegacyFolderSchema } from './migrations'; // +++ Import runMigrations +++
import { installSyncTriggers } from '../sync/triggers.manager';
import { getDbPath, getDataDir } from '../services/storage-path.service';

const dbPath = getDbPath();
console.log(`[数据库连接] 当前数据存储根目录: ${getDataDir()}, 数据库文件: ${dbPath}`);

// 仅在显式开启调试变量时启用 sqlite3.verbose()，避免生产环境每次 SQL 都构造 JS Error().stack 带来额外 CPU 与 GC 开销
const sqliteDriver = process.env.NEXUS_SQLITE_VERBOSE === '1' ? sqlite3.verbose() : sqlite3;
let dbInstancePromise: Promise<sqlite3.Database> | null = null;

export interface RunResult {
    lastID: number;
    changes: number;
}

// --- 同步应用排他锁与写屏障状态机 ---
export const applyContext = new AsyncLocalStorage<{ isApplying: boolean }>();

export const syncRuntimeState = {
    isApplying: false
};

const applyLockWaiters: Array<() => void> = [];
const writeBarrierWaiters: Array<() => void> = [];
let transactionDepth = 0;

type ChangeNotifier = () => void;
let changeNotifier: ChangeNotifier | null = null;

export function registerSyncChangeNotifier(notifier: ChangeNotifier): void {
    changeNotifier = notifier;
}

export function triggerSyncNotify(): void {
    if (changeNotifier) {
        try {
            changeNotifier();
        } catch (e) {
            console.warn('[DB] 触发同步变更通知出错:', e);
        }
    }
}

export function isDbInTransaction(): boolean {
    return transactionDepth > 0;
}

export function getTransactionDepth(): number {
    return transactionDepth;
}

/**
 * 获取应用远端数据的独占写锁 (进入 applying 事务前调用)
 */
export async function acquireApplyLock(): Promise<() => void> {
    while (syncRuntimeState.isApplying) {
        await new Promise<void>(resolve => applyLockWaiters.push(resolve));
    }
    syncRuntimeState.isApplying = true;
    return () => {
        syncRuntimeState.isApplying = false;
        // 优先唤醒下一个排队的同步应用任务；没有排队的同步任务时一次性放行全部挂起业务写入
        if (applyLockWaiters.length > 0) {
            const nextApply = applyLockWaiters.shift();
            if (nextApply) nextApply();
            return;
        }
        const pendingWrites = writeBarrierWaiters.splice(0);
        for (const wake of pendingWrites) {
            wake();
        }
    };
}

export const runDb = async (db: sqlite3.Database, sql: string, params: any[] = []): Promise<RunResult> => {
    const isFromApply = applyContext.getStore()?.isApplying === true;

    // 核心安全屏障：若当前正在应用远端数据，且当前调用来自普通业务（非应用链路）：
    // 异步排队挂起，等待应用事务完成并提交后再放行执行，绝对杜绝被 applying 事务吞噬或回滚！
    while (syncRuntimeState.isApplying && !isFromApply) {
        await new Promise<void>(resolve => writeBarrierWaiters.push(resolve));
    }

    const trimmed = sql.trim().toUpperCase();
    const isSavepointRollback = /^ROLLBACK(\s+TRANSACTION)?\s+TO\b/i.test(trimmed);
    const isTxEnd = !isSavepointRollback && (trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK'));
    if (trimmed.startsWith('BEGIN')) {
        transactionDepth++;
    }

    try {
        const result = await new Promise<RunResult>((resolve, reject) => {
            db.run(sql, params, function (err: Error | null) {
                if (err) {
                    console.error(`[数据库错误] SQL: ${sql.substring(0, 100)}... 错误: ${err.message}`);
                    reject(err);
                } else {
                    resolve({ lastID: this.lastID, changes: this.changes });
                }
            });
        });

        if (isTxEnd) {
            transactionDepth = Math.max(0, transactionDepth - 1);
            if (transactionDepth === 0 && !syncRuntimeState.isApplying) {
                triggerSyncNotify();
            }
        } else if (transactionDepth === 0 && !syncRuntimeState.isApplying) {
            triggerSyncNotify();
        }

        return result;
    } catch (err) {
        if (trimmed.startsWith('BEGIN')) {
            transactionDepth = Math.max(0, transactionDepth - 1);
        } else if (!isSavepointRollback && trimmed.startsWith('ROLLBACK')) {
            transactionDepth = Math.max(0, transactionDepth - 1);
        }
        throw err;
    }
};


export const getDb = <T = any>(db: sqlite3.Database, sql: string, params: any[] = []): Promise<T | undefined> => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err: Error | null, row: T) => {
            if (err) {
                console.error(`[数据库错误] SQL: ${sql.substring(0, 100)}... 参数: ${JSON.stringify(params)} 错误: ${err.message}`);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
};


export const allDb = <T = any>(db: sqlite3.Database, sql: string, params: any[] = []): Promise<T[]> => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err: Error | null, rows: T[]) => {
            if (err) {
                console.error(`[数据库错误] SQL: ${sql.substring(0, 100)}... 参数: ${JSON.stringify(params)} 错误: ${err.message}`);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
};


const runDatabaseInitializations = async (db: sqlite3.Database): Promise<void> => {
    try {
        // 生产级 SQLite 性能与并发调优：开启 WAL 日志模式 + NORMAL 同步 + 5s 锁等待 + 8MB 页缓存 + 内存临时表
        await runDb(db, 'PRAGMA journal_mode = WAL;');
        await runDb(db, 'PRAGMA synchronous = NORMAL;');
        await runDb(db, 'PRAGMA busy_timeout = 5000;');
        await runDb(db, 'PRAGMA cache_size = -8000;');
        await runDb(db, 'PRAGMA temp_store = MEMORY;');
        await runDb(db, 'PRAGMA foreign_keys = ON;');
        for (const tableDef of tableDefinitions) {
            await runDb(db, tableDef.sql);
            if (tableDef.init) {
                await tableDef.init(db);
            }
        }
    } catch (error) {
        console.error('[DB Init] 数据库初始化序列失败:', error);
        throw error;
    }
};


export const getDbInstance = (): Promise<sqlite3.Database> => {
    if (!dbInstancePromise) {
        dbInstancePromise = new Promise((resolve, reject) => {
        
            const db = new sqliteDriver.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (err) => { // Mark callback as async

                if (err) {
                    console.error(`[数据库连接] 打开数据库文件 ${dbPath} 时出错:`, err.message);
                    dbInstancePromise = null;
                    reject(err);
                    return;
                }


        
                try {

                    // 「标签 → 文件夹」改名：必须在建表之前，旧库原地改名，新库空转（见函数注释）
                    await normalizeLegacyFolderSchema(db);
                    // 运行初始表创建
                    await runDatabaseInitializations(db);
                    // +++ 运行数据库迁移 +++
                    await runMigrations(db);
                    // 挂载同步触发器 (熔断安全，受控于 sync_state.enabled)
                    await installSyncTriggers(db);
                    console.log('[数据库] 初始化、迁移与同步触发器就绪。'); 
                    resolve(db);


                } catch (initError) {
                    console.error('[数据库] 连接后初始化失败，正在关闭连接...');
                    dbInstancePromise = null;
                    db.close((closeErr) => {
                        if (closeErr) console.error('[数据库] 初始化失败后关闭连接时出错:', closeErr.message);
                        reject(initError);
                    });

                }
            });
        });
    }
    return dbInstancePromise;
};


process.on('SIGINT', async () => { 
    if (dbInstancePromise) {
        console.log('[DB] 收到 SIGINT，尝试关闭数据库连接...');
        try {

            const db = await dbInstancePromise;
            db.close((err) => {
                if (err) {
                    console.error('[DB] 关闭数据库时出错:', err.message);
                } else {
                    console.log('[DB] 数据库连接已关闭。');
                }
                process.exit(err ? 1 : 0);
            });
        } catch (error) {
            console.error('[DB] 获取数据库实例以关闭时出错 (可能初始化失败):', error);
            process.exit(1);
        }
    } else {
        console.log('[DB] 收到 SIGINT，但数据库连接从未初始化或已失败。');
        process.exit(0);
    }
});


