// xy-bot/config.js
// ✅ 全局配置加载器

import fs from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

// ========================
// 路径定位（基于项目根目录，不依赖当前文件位置）
// ========================
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'xy-data', 'config.yaml');

// ========================
// 内部状态
// ========================
let configData = null;

// ========================
// 默认配置
// ========================
function getDefaultConfig() {
  return {
    blacklist_qq: [],
    blacklist_group: [],
    whitelist_qq: [],
    whitelist_group: [],
  };
}

// ========================
// 安全数组化（兼容「未填」「单值」「数组」三种情况）
// ========================
function toArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)]; // 单个数字/字符串也当成数组处理
}

// ========================
// 加载 / 重载配置
// ========================
export function loadConfig() {
  try {
    // 1. 文件不存在 → 创建
    if (!fs.existsSync(CONFIG_PATH)) {
      console.warn(`⚠️ [配置] 不存在，自动创建: ${CONFIG_PATH}`);
      const dir = dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, YAML.stringify(getDefaultConfig()), 'utf8');
    }

    // 2. 读取解析
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = YAML.parse(fileContents) || {};

    // 3. 规范化（统一字符串，兼容非数组）
    configData = {
      blacklist_qq: toArray(parsed.blacklist_qq),
      blacklist_group: toArray(parsed.blacklist_group),
      whitelist_qq: toArray(parsed.whitelist_qq),
      whitelist_group: toArray(parsed.whitelist_group),
    };

    console.log(
      `✅ [配置] 加载成功 ` +
      `(黑名单 QQ:${configData.blacklist_qq.length} 群:${configData.blacklist_group.length} | ` +
      `白名单 QQ:${configData.whitelist_qq.length} 群:${configData.whitelist_group.length})`
    );
    return configData;
  } catch (e) {
    console.error('❌ [配置] 加载失败:', e.message);
    configData = getDefaultConfig();
    return configData;
  }
}

// ========================
// 获取配置（懒加载，第一次调用时自动加载）
// ========================
export function getConfig() {
  if (!configData) loadConfig();
  return configData;
}

// ========================
// 判定：指定 QQ 是否被屏蔽
// 规则：
//   白名单非空 → 只允许白名单内；白名单为空 → 用黑名单过滤
// ========================
export function isQQAllowed(qq) {
  const cfg = getConfig();
  const qqStr = String(qq);

  // 白名单优先
  if (cfg.whitelist_qq.length > 0) {
    return cfg.whitelist_qq.includes(qqStr);
  }
  // 无白名单时，用黑名单
  return !cfg.blacklist_qq.includes(qqStr);
}

// ========================
// 判定：指定群是否被屏蔽
// ========================
export function isGroupAllowed(groupId) {
  const cfg = getConfig();
  const idStr = String(groupId);

  if (cfg.whitelist_group.length > 0) {
    return cfg.whitelist_group.includes(idStr);
  }
  return !cfg.blacklist_group.includes(idStr);
}

// ========================
// 手动重载（改完配置不想重启机器人时调用）
// ========================
export function reloadConfig() {
  console.log('🔄 [配置] 正在重载...');
  return loadConfig();
}

// ========================
// 默认导出：不预先调用 loadConfig()，避免 ESM 循环依赖问题
// 其他模块可以直接 `import { getConfig } from './config.js'`
// ========================
export default { loadConfig, getConfig, reloadConfig, isQQAllowed, isGroupAllowed };