import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const LOG_DIRECTORY = './data/temp_suspended_ssh_logs/';

/**
 * TemporaryLogStorageService负责管理临时日志文件的原子化读、写、删除及轮替操作。
 */
export class TemporaryLogStorageService {
  constructor() {
    this.ensureLogDirectoryExists();
  }

  /**
   * 确保日志目录存在，如果不存在则创建它。
   */
  async ensureLogDirectoryExists(): Promise<void> {
    try {
      await fs.mkdir(LOG_DIRECTORY, { recursive: true });
      // console.log(`日志目录 '${LOG_DIRECTORY}' 已确保存在。`);
    } catch (error) {
      console.error(`创建日志目录 '${LOG_DIRECTORY}' 失败:`, error);
      // 在实际应用中，这里可能需要更健壮的错误处理
    }
  }

  private getLogFilePath(suspendSessionId: string): string {
    return path.join(LOG_DIRECTORY, `${suspendSessionId}.log`);
  }

  /**
   * 将数据写入指定挂起会话的日志文件。
   * 如果文件大小超过MAX_LOG_SIZE_BYTES，将采取轮替策略（清空并从头开始写）。
   * @param suspendSessionId - 挂起会话的ID。
   * @param data - 要写入的数据。
   */
  async writeToLog(suspendSessionId: string, data: string): Promise<void> {
    const filePath = this.getLogFilePath(suspendSessionId);
    try {
      await this.ensureLogDirectoryExists(); // 确保目录存在
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          throw e;
        }
        // 文件不存在，是正常情况，后续会创建
      }

      if (stat && stat.size >= MAX_LOG_SIZE_BYTES) {
        // 文件过大，执行轮替策略：清空文件
        console.log(`日志文件 '${filePath}' 大小达到 ${MAX_LOG_SIZE_BYTES / (1024 * 1024)}MB，执行轮替（清空）。`);
        await fs.writeFile(filePath, data, 'utf8'); // 清空并写入新数据
      } else {
        await fs.appendFile(filePath, data, 'utf8');
      }
    } catch (error) {
      console.error(`写入日志文件 '${filePath}' 失败:`, error);
      throw error; // 重新抛出错误，让调用者处理
    }
  }

  /**
   * 覆盖写入（或清空）指定挂起会话的日志文件。
   * 用于实时同步对齐最新的屏幕历史或清空屏幕状态。
   * @param suspendSessionId - 挂起会话的ID。
   * @param data - 要覆盖写入的数据。
   */
  async overwriteLog(suspendSessionId: string, data: string): Promise<void> {
    const filePath = this.getLogFilePath(suspendSessionId);
    try {
      await this.ensureLogDirectoryExists();
      await fs.writeFile(filePath, data, 'utf8');
    } catch (error) {
      console.error(`覆盖写入日志文件 '${filePath}' 失败:`, error);
      throw error;
    }
  }

  /**
   * 读取指定挂起会话的日志文件内容。
   * @param suspendSessionId - 挂起会话的ID。
   * @returns 返回日志文件的内容。如果文件不存在，则返回空字符串。
   */
  async readLog(suspendSessionId: string): Promise<string> {
    const filePath = this.getLogFilePath(suspendSessionId);
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return data;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // console.log(`日志文件 '${filePath}' 不存在，返回空内容。`);
        return ''; // 文件不存在，通常意味着没有日志
      }
      console.error(`读取日志文件 '${filePath}' 失败:`, error);
      throw error;
    }
  }

  /**
   * 删除指定挂起会话的日志文件。
   * @param suspendSessionId - 挂起会话的ID。
   */
  async deleteLog(suspendSessionId: string): Promise<void> {
    const filePath = this.getLogFilePath(suspendSessionId);
    try {
      await fs.unlink(filePath);
      // console.log(`日志文件 '${filePath}' 已成功删除。`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // console.warn(`尝试删除日志文件 '${filePath}' 时发现文件已不存在，操作忽略。`);
        return; // 文件不存在，无需操作
      }
      console.error(`删除日志文件 '${filePath}' 失败:`, error);
      throw error;
    }
  }

  /**
   * 列出日志目录中的所有日志文件名（不含扩展名，即suspendSessionId）。
   * 这可以用于 `SshSuspendService` 初始化时加载已断开的会话。
   * @returns 返回包含所有 suspendSessionId 的数组。
   */
  async listLogFiles(): Promise<string[]> {
    try {
      await this.ensureLogDirectoryExists();
      const files = await fs.readdir(LOG_DIRECTORY);
      return files
        .filter(file => file.endsWith('.log'))
        .map(file => file.replace(/\.log$/, ''));
    } catch (error) {
      console.error(`列出日志目录 '${LOG_DIRECTORY}' 中的文件失败:`, error);
      return []; // 发生错误时返回空数组
    }
  }
}

// 单例模式导出
export const temporaryLogStorageService = new TemporaryLogStorageService();