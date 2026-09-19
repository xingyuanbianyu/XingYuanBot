import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 配置文件路径
const CONFIG_PATH = path.join(__dirname, './config.yaml');
// 模板文件路径
const EXAMPLE_PATH = path.join(__dirname, './config.yaml.example');

let cache = null;

/**
 * 初始化配置文件
 * 逻辑：如果 config.yaml 不存在，尝试复制 example，否则创建默认配置
 */
function initConfigFile() {
    // 1. 检查主配置文件是否存在
    if (!fs.existsSync(CONFIG_PATH)) {
        console.log('检测到配置文件缺失，正在尝试初始化...');

        // 2. 尝试寻找 example 模板
        if (fs.existsSync(EXAMPLE_PATH)) {
            try {
                const content = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
                fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
                console.log('已根据 config.yaml.example 创建 config.yaml');
            } catch (e) {
                console.error('复制模板文件失败:', e);
            }
        } else {
            // 3. 如果没有模板，创建一个最基础的默认配置
            const defaultConfig = {
                permissions: {
                    owners: {},
                    admins: {},
                    permission_switch: {}
                }
            };
            fs.writeFileSync(CONFIG_PATH, yaml.stringify(defaultConfig), 'utf-8');
            console.log('未找到模板，已创建默认 config.yaml');
        }
    }
}

/**
 * 加载配置
 */
function loadConfig() {
    // 每次加载前，确保文件存在（这步很关键，防止报错）
    initConfigFile();

    // 强制重新读取，不使用旧缓存，确保拿到最新的（或者是刚生成的）文件内容
    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        cache = yaml.parse(content);
    } catch (e) {
        console.error('配置文件解析失败，请检查格式:', e);
        return {}; // 返回空对象防止后续报错
    }

    return cache;
}

// 获取某人的实际可用角色（考虑权限开关）
export function getRole(qq) {
  const qqStr = String(qq);
  const config = loadConfig();
  const owners = config.permissions?.owners || {};
  const permStatus = config.permissions?.owner_permission || {};


  // 检查是否是主人
  if (owners[qqStr] !== undefined) {
    if (owners[qqStr] === true || owners[qqStr] === 'true') {
      return 'master'; // 大主人，永远可用
    } else {
      // 小主人：检查权限状态，0=不可用，1或未配置=可用
      if (permStatus[qqStr] === 0) {
        return 'member'; // 权限关闭，当作普通成员
      }
      return 'owner'; // 权限开启，小主人
    }
  }

  // 检查是否是管理员
  if (config.permissions?.admins && config.permissions.admins[qqStr] !== undefined) {
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
