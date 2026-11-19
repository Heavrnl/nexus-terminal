import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataPath } from '../services/storage-path.service';

const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * TemporaryLogStorageService负责管理临时日志文件的原子化读、写、删除及轮替操作。
 *
 * 按 suspendSessionId 维护串行操作队列，避免高吞吐输出时多个并发 writeToLog / overwriteLog / deleteLog
 * 竞态乱序或相互覆盖。
 */
export class TemporaryLogStorageService {
  private readonly opQueues = new Map<string, Promise<unknown>>();

  constructor() {
    this.ensureLogDirectoryExists();
  }

  private getLogDirectory(): string {
    return getDataPath('temp_suspended_ssh_logs');
  }

  /**
   * 按日志标识串行排队执行磁盘 I/O，防止高吞吐流式写入乱序与覆盖竞态。
   */
  private enqueueOp<T>(suspendSessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.opQueues.get(suspendSessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    const tracked = next.finally(() => {
      if (this.opQueues.get(suspendSessionId) === tracked) {
        this.opQueues.delete(suspendSessionId);
      }
    });
    this.opQueues.set(suspendSessionId, tracked);
    return next;
  }

  /**
   * 确保日志目录存在，如果不存在则创建它。
   */
  async ensureLogDirectoryExists(): Promise<void> {
    const logDir = this.getLogDirectory();
    try {
      await fs.mkdir(logDir, { recursive: true });
    } catch (error) {
      console.error(`创建日志目录 '${logDir}' 失败:`, error);
    }
  }

  private getLogFilePath(suspendSessionId: string): string {
    return path.join(this.getLogDirectory(), `${suspendSessionId}.log`);
  }

  /**
   * 将数据写入指定挂起会话的日志文件。
   * 如果文件大小超过MAX_LOG_SIZE_BYTES，将采取轮替策略（清空并从头开始写）。
   * @param suspendSessionId - 挂起会话的ID。
   * @param data - 要写入的数据。
   */
  async writeToLog(suspendSessionId: string, data: string): Promise<void> {
    if (!data) return;
    return this.enqueueOp(suspendSessionId, async () => {
      const filePath = this.getLogFilePath(suspendSessionId);
      try {
        await this.ensureLogDirectoryExists();
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }

        if (stat && stat.size >= MAX_LOG_SIZE_BYTES) {
          console.log(`日志文件 '${filePath}' 大小达到 ${MAX_LOG_SIZE_BYTES / (1024 * 1024)}MB，执行轮替（清空）。`);
          await fs.writeFile(filePath, data, 'utf8');
        } else {
          await fs.appendFile(filePath, data, 'utf8');
        }
      } catch (error) {
        console.error(`写入日志文件 '${filePath}' 失败:`, error);
        throw error;
      }
    });
  }

  /**
   * 覆盖写入（或清空）指定挂起会话的日志文件。
   * 用于实时同步对齐最新的屏幕历史或清空屏幕状态。
   * @param suspendSessionId - 挂起会话的ID。
   * @param data - 要覆盖写入的数据。
   */
  async overwriteLog(suspendSessionId: string, data: string): Promise<void> {
    return this.enqueueOp(suspendSessionId, async () => {
      const filePath = this.getLogFilePath(suspendSessionId);
      try {
        await this.ensureLogDirectoryExists();
        await fs.writeFile(filePath, data, 'utf8');
      } catch (error) {
        console.error(`覆盖写入日志文件 '${filePath}' 失败:`, error);
        throw error;
      }
    });
  }

  /**
   * 读取指定挂起会话的日志文件内容（等待前置排队写入完成后再读取）。
   * @param suspendSessionId - 挂起会话的ID。
   * @returns 返回日志文件的内容。如果文件不存在，则返回空字符串。
   */
  async readLog(suspendSessionId: string): Promise<string> {
    return this.enqueueOp(suspendSessionId, async () => {
      const filePath = this.getLogFilePath(suspendSessionId);
      try {
        const data = await fs.readFile(filePath, 'utf8');
        return data;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return '';
        }
        console.error(`读取日志文件 '${filePath}' 失败:`, error);
        throw error;
      }
    });
  }

  /**
   * 删除指定挂起会话的日志文件。
   * @param suspendSessionId - 挂起会话的ID。
   */
  async deleteLog(suspendSessionId: string): Promise<void> {
    return this.enqueueOp(suspendSessionId, async () => {
      const filePath = this.getLogFilePath(suspendSessionId);
      try {
        await fs.unlink(filePath);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return;
        }
        console.error(`删除日志文件 '${filePath}' 失败:`, error);
        throw error;
      }
    });
  }

  /**
   * 列出日志目录中的所有日志文件名（不含扩展名，即suspendSessionId）。
   * 这可以用于 `SshSuspendService` 初始化时加载已断开的会话。
   * @returns 返回包含所有 suspendSessionId 的数组。
   */
  async listLogFiles(): Promise<string[]> {
    const logDir = this.getLogDirectory();
    try {
      await this.ensureLogDirectoryExists();
      const files = await fs.readdir(logDir);
      return files
        .filter(file => file.endsWith('.log'))
        .map(file => file.replace(/\.log$/, ''));
    } catch (error) {
      console.error(`列出日志目录 '${logDir}' 中的文件失败:`, error);
      return [];
    }
  }
}

// 单例模式导出
export const temporaryLogStorageService = new TemporaryLogStorageService();