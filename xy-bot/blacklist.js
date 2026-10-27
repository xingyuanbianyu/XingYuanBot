import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../xy-data/config.yaml');

// 确保配置目录存在
const CONFIG_DIR = path.dirname(CONFIG_PATH);
if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

/**
 * 加载配置：使用 parseDocument 保留原有注释和排版
 */
function loadConfigDoc() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return new YAML.Document({});
    }
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    const doc = YAML.parseDocument(content);
    
    if (doc.errors && doc.errors.length > 0) {
        throw new Error(`YAML 语法错误: ${doc.errors[0].message}`);
    }
    return doc;
}

/**
 * 原子化保存配置：带有临时文件清理机制，兼容 Windows 文件锁定
 */
function saveConfigDoc(doc) {
    const tmpPath = CONFIG_PATH + '.tmp';
    try {
        fs.writeFileSync(tmpPath, doc.toString(), 'utf8');
        // 在 Windows 下，如果目标文件被占用，renameSync 会报错
        // 先尝试删除原文件（Windows下 rename 不能直接覆盖被锁文件）
        if (process.platform === 'win32' && fs.existsSync(CONFIG_PATH)) {
            try { fs.unlinkSync(CONFIG_PATH); } catch (_) {}
        }
        fs.renameSync(tmpPath, CONFIG_PATH);
    } catch (err) {
        if (fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
        throw err;
    }
}

/**
 * 通用名单管理器
 */
export function manageList(listType, targetType, target, isAdd) {
    try {
        const doc = loadConfigDoc();
        const listKey = `${listType}_${targetType}`;
        
        // 🌟 核心修复：doc.get 拿到的是 YAMLSeq，必须先转成普通 JS 数组！
        let rawList = doc.get(listKey);
        let currentList = [];

        if (rawList) {
            if (typeof rawList.toJSON === 'function') {
                currentList = rawList.toJSON(); // 解析 YAMLSeq 为 JS 数组
            } else if (Array.isArray(rawList)) {
                currentList = rawList;
            } else {
                currentList = [rawList];
            }
        }

        // 确保所有元素都是干净的字符串
        currentList = currentList.map(item => String(item).trim()).filter(Boolean);

        const targetStr = String(target).trim();
        const index = currentList.indexOf(targetStr);
        
        const typeName = targetType === 'qq' ? 'QQ' : 'Q群';
        const listName = listType === 'blacklist' ? '黑名单' : '白名单';

        if (isAdd) {
            if (index !== -1) return `❌ 该${typeName}已在${listName}中。`;
            currentList.push(targetStr);
        } else {
            if (index === -1) return `❌ 该${typeName}不在${listName}中。`;
            currentList.splice(index, 1);
        }

        // 将修改后的普通数组放回 Document
        doc.set(listKey, currentList);
        
        // 保存到磁盘（保留注释）
        saveConfigDoc(doc);
        
        // 触发内存热重载
        if (typeof globalThis._configReload === 'function') {
            try { globalThis._configReload(); } catch (e) {}
        }
        
        return `✅ 成功将 ${targetStr} ${isAdd ? '加入' : '移出'}${listName}。`;
    } catch (e) {
        return `❌ 操作失败：${e.message}`;
    }
}

// ==========================================
// 快捷方法
// ==========================================
export function manageBlacklist(type, target, isAdd) {
    return manageList('blacklist', type, target, isAdd);
}

export function manageWhitelist(type, target, isAdd) {
    return manageList('whitelist', type, target, isAdd);
}