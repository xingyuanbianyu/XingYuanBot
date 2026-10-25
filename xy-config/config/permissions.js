import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, './config.yaml');
const EXAMPLE_PATH = path.join(__dirname, './config.yaml.example');

let cache = null;
let lastMtime = 0;

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

export function getRole(qq, botId = null) {
  const qqStr = String(qq);
  const botStr = botId ? String(botId) : null;
  
  const config = loadConfig();
  const owners = config.permissions?.owners || {};
  const permStatus = config.permissions?.owner_permission || {};

  if (owners[qqStr] !== undefined) {
    const val = owners[qqStr];
    
    // ==========================================
    // 🌟 局部权限（数组形式）
    // 格式如：['10001:master', '10002:owner'] 或兼容旧版 ['10001']
    // ==========================================
    if (Array.isArray(val)) {
      if (!botStr) return 'member';
      
      // 查找当前 Bot 号是否在数组中
      const matchedItem = val.find(item => {
          const str = String(item);
          // 兼容旧版（直接存 Bot 号）或者新版（存 Bot号:角色）
          return str === botStr || str.split(':')[0] === botStr;
      });

      if (matchedItem) {
          const str = String(matchedItem);
          if (str.includes(':')) {
              const role = str.split(':')[1];
              return role === 'owner' ? 'owner' : 'master';
          }
          return 'master'; // 旧版默认按大主人处理
      }
      return 'member';
    }
    
    // ==========================================
    // 🌟 全局权限（布尔值）
    // ==========================================
    if (val === true || val === 'true') {
      return 'master'; // 全局大主人
    } else {
      if (String(permStatus[qqStr]) === '0') return 'member';
      return 'owner'; // 全局小主人
    }
  }

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