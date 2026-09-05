// command.js - 命令处理器
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

class CommandHandler {
    constructor() {
        // 配置文件路径
        this.configPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'xy-config', 'config.yaml');
        this.adminAccount = this.loadAdminAccount();
    }

    // 1. 读取后台账户信息
    loadAdminAccount() {
        try {
            if (!fs.existsSync(this.configPath)) {
                console.warn('⚠️ 配置文件不存在，使用默认账户');
                return { username: 'XYBY', password: 'xingyuan', password_hash: '' };
            }

            const fileContent = fs.readFileSync(this.configPath, 'utf8');
            const config = yaml.load(fileContent);

            // 从配置中读取账户信息，如果不存在则使用默认值
            return {
                username: config.admin?.username || 'XYBY',
                password: config.admin?.password || 'xingyuan',
                // 预留哈希字段，暂时没用
                password_hash: config.admin?.password_hash || ''
            };
        } catch (error) {
            console.error('❌ 读取后台账户配置失败:', error.message);
            // 出错时返回默认值，保证程序不崩溃
            return { username: 'XYBY', password: 'xingyuan', password_hash: '' };
        }
    }

    // 2. 处理命令（示例）
    async handleCommand(command, args) {
        console.log(`收到命令: ${command}`, args);
        // 这里可以添加具体的命令处理逻辑
    }
}

// === 🔴 新增：独立的账户验证函数 ===
/**
 * 验证后台账户密码
 * @param {string} inputUsername - 用户输入的用户名
 * @param {string} inputPassword - 用户输入的密码
 * @returns {boolean} - 验证是否成功
 */
async function verifyAdminAccount(inputUsername, inputPassword) {
    // 1. 实例化 CommandHandler 来读取配置
    // (在实际项目中，这里可以优化为单例模式，避免重复读取文件)
    const handler = new CommandHandler();
    const { username, password, password_hash } = handler.adminAccount;

    // 2. 优先检查用户名是否匹配
    if (inputUsername !== username) {
        return false;
    }

    // 3. 优先使用哈希验证（为未来准备）
    if (password_hash) {
        // TODO: 这里未来会实现哈希比对逻辑
        // const crypto = require('crypto');
        // const inputHash = crypto.createHash('sha256').update(inputPassword).digest('hex');
        // return inputHash === password_hash;
        console.log('ℹ️ 哈希验证功能尚未实现，当前降级为明文验证');
        return inputPassword === password;
    }

    // 4. 当前使用明文密码验证
    return inputPassword === password;
}
// === 新增结束 ===

export { CommandHandler, verifyAdminAccount };
