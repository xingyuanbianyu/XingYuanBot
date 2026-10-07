import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 配置文件路径
const CONFIG_PATH = path.join(__dirname, './config.yaml');
// 模板文件路径
const EXAMPLE_PATH = path.join(__dirname, './config.yaml.example');

// 定义一个安全的默认配置结构
const DEFAULT_CONFIG = {
    permissions: {
        owners: {},
        admins: {},
        permission_switch: {}
    }
};

// 初始化缓存，防止 loadConfig 第一次执行前报错
let cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

/**
 * 初始化配置文件
 */
function initConfigFile() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.log('检测到配置文件缺失，正在尝试初始化...');
        if (fs.existsSync(EXAMPLE_PATH)) {
            try {
                const content = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
                fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
                console.log('已根据 config.yaml.example 创建 config.yaml');
            } catch (e) {
                console.error('复制模板文件失败:', e);
            }
        } else {
            fs.writeFileSync(CONFIG_PATH, yaml.stringify(DEFAULT_CONFIG), 'utf-8');
            console.log('未找到模板，已创建默认 config.yaml');
        }
    }
}

/**
 * 重新加载配置（只在初始化或文件变动时调用）
 */
function reloadConfig() {
    initConfigFile(); // 确保文件存在
    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = yaml.parse(content);
        
        // 防空兜底：如果解析为空，或者没有 permissions 节点，给予默认结构
        if (parsed && typeof parsed === 'object') {
            cache = parsed;
            if (!cache.permissions) {
                cache.permissions = { owners: {}, admins: {}, permission_switch: {} };
            } else {
                // 确保内部的三个子节点也存在
                if (!cache.permissions.owners) cache.permissions.owners = {};
                if (!cache.permissions.admins) cache.permissions.admins = {};
                if (!cache.permissions.permission_switch) cache.permissions.permission_switch = {};
            }
        }
    } catch (e) {
        console.error('❌ 配置文件解析失败，请检查YAML格式:', e);
        // 解析失败时，保留旧的 cache，不覆盖，防止机器人直接崩溃
    }
}

// ================= 初始加载与热更新监听 =================

// 1. 启动时先执行一次初始加载
reloadConfig();

// 2. 监听文件变化，实现热更新（不需要重启机器人）
fs.watch(CONFIG_PATH, (eventType) => {
    if (eventType === 'change') {
        // 延迟 100 毫秒执行，防止记事本/编辑器保存瞬间出现空文件导致读取失败
        setTimeout(() => {
            console.log('🔄 检测到 config.yaml 变动，已自动重新加载配置...');
            reloadConfig();
        }, 100);
    }
});

// ================= 对外暴露的权限接口 =================

// 获取某人的实际可用角色（考虑权限开关）
export function getRole(qq) {
    const qqStr = String(qq);
    const config = cache; // 直接使用内存中的 cache，性能极高

    const owners = config.permissions.owners || {};
    const permStatus = config.permissions.permission_switch || {};

    // 检查是否是主人
    if (owners[qqStr] !== undefined) {
        if (owners[qqStr] === true || owners[qqStr] === 'true') {
            return 'master'; // 大主人，永远可用
        } else {
            // 小主人：检查权限状态，0=不可用，1或未配置=可用
            // 【修复】使用 Number() 转换，兼容 0 和 "0" 两种写法
            if (Number(permStatus[qqStr]) === 0) {
                return 'member'; // 权限关闭，当作普通成员
            }
            return 'owner'; // 权限开启，小主人
        }
    }

    // 检查是否是管理员
    if (config.permissions.admins && config.permissions.admins[qqStr] !== undefined) {
        return 'admin';
    }

    // 默认普通成员
    return 'member';
}

// 检查是否有权限（true=有权限，false=无权限）
export function hasPermission(qq, requiredRole) {
    const role = getRole(qq);
    const roleLevel = {
        'member': 0,
        'admin': 1,
        'owner': 2,
        'master': 3
    };
    return roleLevel[role] >= roleLevel[requiredRole];
}