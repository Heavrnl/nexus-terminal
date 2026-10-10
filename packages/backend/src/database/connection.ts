
import sqlite3, { OPEN_READWRITE, OPEN_CREATE } from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { tableDefinitions } from './schema.registry';
import { runMigrations } from './migrations'; // +++ Import runMigrations +++
import { getDbPath, getDataDir } from '../services/storage-path.service';

const dbPath = getDbPath();
console.log(`[数据库连接] 当前数据存储根目录: ${getDataDir()}, 数据库文件: ${dbPath}`);

const verboseSqlite3 = sqlite3.verbose();
let dbInstancePromise: Promise<sqlite3.Database> | null = null;

interface RunResult {
    lastID: number;
    changes: number;
}


export const runDb = (db: sqlite3.Database, sql: string, params: any[] = []): Promise<RunResult> => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err: Error | null) {
            if (err) {
                console.error(`[数据库错误] SQL: ${sql.substring(0, 100)}... 参数: ${JSON.stringify(params)} 错误: ${err.message}`);
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
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
        
            const db = new verboseSqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (err) => { // Mark callback as async

                if (err) {
                    console.error(`[数据库连接] 打开数据库文件 ${dbPath} 时出错:`, err.message);
                    dbInstancePromise = null;
                    reject(err);
                    return;
                }


        
                try {

                    // 运行初始表创建
                    await runDatabaseInitializations(db);
                    // +++ 运行数据库迁移 +++
                    await runMigrations(db);
                    console.log('[数据库] 初始化和迁移完成。'); 
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


