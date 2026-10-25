import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

// 🌟 保持绝对路径定位
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../xy-data/config.yaml');

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    return YAML.parse(content) || {};
}

// 🌟 核心优化：原子化写入，防止文件损坏
function saveConfig(data) {
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, YAML.stringify(data), 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH); // 瞬间替换，保证文件完整性
}

/**
 * 通用名单管理器 (黑/白名单、QQ/群)
 * @param {'blacklist'|'whitelist'} listType - 名单类型
 * @param {'qq'|'group'} targetType - 目标类型
 * @param {string} target - 目标号码
 * @param {boolean} isAdd - true为添加，false为移除
 * @returns {string} 结果提示
 */
export function manageList(listType, targetType, target, isAdd) {
    try {
        const config = loadConfig();
        // 拼装出正确的键名，比如 'blacklist_qq' 或 'whitelist_group'
        const listKey = `${listType}_${targetType}`;
        
        if (!config[listKey]) {
            config[listKey] = [];
        }
        
        // 🌟 兼容性处理：如果文件里填的不是数组（单值），强制转数组
        if (!Array.isArray(config[listKey])) {
            config[listKey] = [String(config[listKey])];
        }

        // 🌟 强制转 String，对齐 config.js
        const targetStr = String(target);
        const index = config[listKey].indexOf(targetStr);
        
        const typeName = targetType === 'qq' ? 'QQ' : 'Q群';
        const listName = listType === 'blacklist' ? '黑名单' : '白名单';

        if (isAdd) {
            if (index !== -1) return `❌ 该${typeName}已在${listName}中。`;
            config[listKey].push(targetStr);
        } else {
            if (index === -1) return `❌ 该${typeName}不在${listName}中。`;
            config[listKey].splice(index, 1);
        }

        saveConfig(config);
        
        // 🌟 主动触发内存热重载 (如果全局挂载了该方法)
        // 你可以在 main.js 或 config.js 里挂载：globalThis._configReload = reloadConfig;
        if (typeof globalThis._configReload === 'function') {
            globalThis._configReload();
        }
        
        return `✅ 成功将 ${targetStr} ${isAdd ? '加入' : '移出'}${listName}。`;
    } catch (e) {
        return `❌ 操作失败：${e.message}`;
    }
}

// ==========================================
// 为了保持你之前的代码调用习惯，提供快捷方法
// ==========================================

export function manageBlacklist(type, target, isAdd) {
    return manageList('blacklist', type, target, isAdd);
}

export function manageWhitelist(type, target, isAdd) {
    return manageList('whitelist', type, target, isAdd);
}