import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url'; // 🌟 新增，用于安全定位路径
import YAML from 'yaml';

// 🌟 修复坑二：使用绝对路径定位，无论你在哪个目录启动都不会找错文件
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 假设这个文件在 xy-bot 目录下，那么上一级的 xy-data 就是配置文件所在地
const CONFIG_PATH = path.resolve(__dirname, '../xy-data/config.yaml');

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    return YAML.parse(content) || {};
}

function saveConfig(data) {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify(data), 'utf8');
}

/**
 * 管理黑名单
 * @param {string} type - 目标类型：'qq' 或 'group'
 * @param {string} target - 目标号码
 * @param {boolean} isAdd - true为拉黑，false为取消
 * @returns {string} 结果提示
 */
export function manageBlacklist(type, target, isAdd) {
    try {
        const config = loadConfig();
        const listKey = type === 'qq' ? 'blacklist_qq' : 'blacklist_group';
        
        if (!config[listKey]) {
            config[listKey] = [];
        }
        
        // 🌟 修复坑一：强制转为 String，与 config.js 中的 toArray 保持绝对一致
        const targetStr = String(target);
        const index = config[listKey].indexOf(targetStr);

        if (isAdd) {
            // 拉黑操作
            if (index !== -1) {
                return `❌ 该${type === 'qq' ? 'QQ' : 'Q群'}已在黑名单中。`;
            }
            config[listKey].push(targetStr); // 存入字符串
            saveConfig(config);
            return `✅ 成功将 ${targetStr} 加入黑名单。`;
        } else {
            // 取消拉黑操作
            if (index === -1) {
                return `❌ 该${type === 'qq' ? 'QQ' : 'Q群'}不在黑名单中。`;
            }
            config[listKey].splice(index, 1);
            saveConfig(config);
            return `✅ 成功将 ${targetStr} 移出黑名单。`;
        }
    } catch (e) {
        return `❌ 操作失败：${e.message}`;
    }
}