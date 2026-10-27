// xy-config/config/permissions.js
import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, './config.yaml');
const EXAMPLE_PATH = path.join(__dirname, './config.yaml.example');

let cache = null;
let lastMtime = 0;
let dbInited = false;

// ==========================================
// 1. 配置与文件初始化
// ==========================================
function initConfigFile() {
    if (!fs.existsSync(CONFIG_PATH)) {
        if (fs.existsSync(EXAMPLE_PATH)) {
            try { fs.writeFileSync(CONFIG_PATH, fs.readFileSync(EXAMPLE_PATH, 'utf-8'), 'utf-8'); } catch (e) {}
        } else {
            const defaultConfig = { permissions: { owners: {}, admins: {}, owner_permission: {} } };
            fs.writeFileSync(CONFIG_PATH, yaml.stringify(defaultConfig), 'utf-8');
        }
    }
}

function loadConfig() {
    initConfigFile();
    try {
        const stats = fs.statSync(CONFIG_PATH);
        const currentMtime = stats.mtimeMs;
        if (cache && currentMtime === lastMtime) return cache;

        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        cache = yaml.parse(content);
        lastMtime = currentMtime;
        return cache;
    } catch (e) {
        console.error('配置文件解析失败:', e);
        return cache || {};
    }
}

export function clearPermissionCache() {
    cache = null;
    lastMtime = 0;
}

// ==========================================
// 2. 数据库表初始化 (懒加载)
// ==========================================
function ensureTable() {
    if (dbInited) return true;
    if (typeof globalThis.db !== 'function') return false;

    try {
        globalThis.db('exec', {
            sql: `CREATE TABLE IF NOT EXISTS bot_permissions (
                user_id TEXT NOT NULL,
                bot_id TEXT NOT NULL,
                role TEXT NOT NULL,
                PRIMARY KEY (user_id, bot_id)
            )`
        });
        dbInited = true;
        return true;
    } catch (e) {
        console.error('❌ [权限] 初始化数据库表失败:', e.message);
        return false;
    }
}

// ==========================================
// 3. 核心查询逻辑
// ==========================================
export function getRole(qq, botId = null) {
    const qqStr = String(qq);
    const botStr = botId ? String(botId) : null;

    // 第一步：优先查局部权限数据库
    if (botStr && ensureTable()) {
        try {
            const res = globalThis.db('find', {
                table: 'bot_permissions',
                where: 'user_id = ? AND bot_id = ?',
                params: [qqStr, botStr],
                all: false
            });
            if (res.success && res.data) {
                return res.data.role; // 返回 master / owner
            }
        } catch (e) {
            console.error(`⚠️ [权限] 查询数据库局部权限失败: ${e.message}`);
        }
    }

    // 第二步：查全局 YAML 权限
    const config = loadConfig();
    const owners = config.permissions?.owners || {};
    const permStatus = config.permissions?.owner_permission || {};

    if (owners[qqStr] !== undefined) {
        const val = owners[qqStr];
        
        if (Array.isArray(val)) {
            return 'member'; 
        }
        
        if (val === true || val === 'true') {
            return 'master'; // 全局大主人
        } else {
            // 🌟 核心：只要值为 "0" 或 0，就判定为普通成员
            if (String(permStatus[qqStr]) === '0') return 'member';
            return 'owner'; // 全局小主人
        }
    }

    // 全局管理员
    if (config.permissions?.admins && config.permissions.admins[qqStr] !== undefined) {
        return 'admin';
    }

    return 'member';
}

export function hasPermission(qq, requiredRole, botId = null) {
    const role = getRole(qq, botId);
    const roleLevel = { 'member': 0, 'admin': 1, 'owner': 2, 'master': 3 };
    return roleLevel[role] >= roleLevel[requiredRole];
}

// ==========================================
// 4. 局部权限管理 API（供插件调用）
// ==========================================

export function setLocalPermission(qq, botId, role) {
    if (!ensureTable()) return { success: false, error: '数据库未就绪' };
    if (!['master', 'owner'].includes(role)) return { success: false, error: '非法的角色类型' };
    
    try {
        const res = globalThis.db('exec', {
            sql: 'INSERT OR REPLACE INTO bot_permissions (user_id, bot_id, role) VALUES (?, ?, ?)',
            params: [String(qq), String(botId), String(role)]
        });
        return res;
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export function removeLocalPermission(qq, botId) {
    if (!ensureTable()) return { success: false, error: '数据库未就绪' };
    try {
        const res = globalThis.db('exec', {
            sql: 'DELETE FROM bot_permissions WHERE user_id = ? AND bot_id = ?',
            params: [String(qq), String(botId)]
        });
        return res;
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export function listLocalPermissions(botId) {
    if (!ensureTable()) return [];
    try {
        const res = globalThis.db('find', {
            table: 'bot_permissions',
            where: 'bot_id = ?',
            params: [String(botId)],
            all: true
        });
        return res.success ? res.data : [];
    } catch (e) {
        return [];
    }
}

export function listUserPermissions(userId) {
    if (!ensureTable()) return [];
    try {
        const res = globalThis.db('find', {
            table: 'bot_permissions',
            where: 'user_id = ?',
            params: [String(userId)],
            all: true
        });
        return res.success ? res.data : [];
    } catch (e) {
        return [];
    }
}

/**
 * 🌟 终极修复：获取所有主人（绝对过滤掉已被关闭权限的人）
 * @param {string} botId 当前接收消息的 Bot 号
 * @returns {string[]} 去重后且权限绝对有效的主人 QQ 数组
 */
export function getAllOwners(botId = null) {
    const potentialOwners = new Set();
    
    // 1. 先把所有可能是主人的 QQ 收集起来（不要在这里判断权限开关）
    const config = loadConfig();
    const ownersObj = config.permissions?.owners || {};
    
    for (const qq of Object.keys(ownersObj)) {
        const qqStr = String(qq).trim();
        if (qqStr) potentialOwners.add(qqStr);
    }
    
    // 2. 收集局部数据库里的主人
    if (botId && ensureTable()) {
        try {
            const res = globalThis.db('find', {
                table: 'bot_permissions',
                where: 'bot_id = ?',
                params: [String(botId)],
                all: true
            });
            if (res.success && res.data) {
                for (const row of res.data) {
                    potentialOwners.add(String(row.user_id));
                }
            }
        } catch (e) {}
    }
    
    // 3. 🌟 核心绝杀：用 getRole 进行最权威的过滤！
    // 只要 getRole 说你是 member，你就别想进这个名单
    const validOwners = [];
    for (const owner of potentialOwners) {
        const role = getRole(owner, botId);
        if (role === 'master' || role === 'owner') {
            validOwners.push(owner);
        }
    }
    
    return validOwners;
}