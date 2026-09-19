import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

// 根据项目结构定位 config.yaml
const CONFIG_PATH = path.join(process.cwd(), './xy-data/config.yaml');

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
        
        const targetNum = Number(target);
        const index = config[listKey].indexOf(targetNum);

        if (isAdd) {
            // 拉黑操作
            if (index !== -1) {
                return `❌ 该${type === 'qq' ? 'QQ' : 'Q群'}已在黑名单中。`;
            }
            config[listKey].push(targetNum);
            saveConfig(config);
            return `✅ 成功将 ${target} 加入黑名单。`;
        } else {
            // 取消拉黑操作
            if (index === -1) {
                return `❌ 该${type === 'qq' ? 'QQ' : 'Q群'}不在黑名单中。`;
            }
            config[listKey].splice(index, 1);
            saveConfig(config);
            return `✅ 成功将 ${target} 移出黑名单。`;
        }
    } catch (e) {
        return `❌ 操作失败：${e.message}`;
    }
}
