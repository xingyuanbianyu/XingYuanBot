// xy-bot/config.js
// ✅ 全局配置加载器

import fs from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

// 统一日志
const log = (msg) => (globalThis.print || console.log)(msg);
const logErr = (msg) => (globalThis.print || console.error)(msg);

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
// 🌟 内部使用 Set 加速 O(1) 查找
let _qqBlackSet = new Set();
let _qqWhiteSet = new Set();
let _groupBlackSet = new Set();
let _groupWhiteSet = new Set();

let watchTimer = null; // 防抖定时器
let watcherInstance = null; // 保存 watcher 引用，防止 GC

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
      log(`⚠️ [配置] 不存在，自动创建: ${CONFIG_PATH}`);
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

    // 🌟 4. 同步更新内部 Set，提升查询性能
    _qqBlackSet = new Set(configData.blacklist_qq);
    _qqWhiteSet = new Set(configData.whitelist_qq);
    _groupBlackSet = new Set(configData.blacklist_group);
    _groupWhiteSet = new Set(configData.whitelist_group);

    log(
      `✅ [配置] 加载成功 ` +
      `(黑名单 QQ:${_qqBlackSet.size} 群:${_groupBlackSet.size} | ` +
      `白名单 QQ:${_qqWhiteSet.size} 群:${_groupWhiteSet.size})`
    );
    return configData;
  } catch (e) {
    logErr('❌ [配置] 加载失败:', e.message);
    configData = getDefaultConfig();
    // 清空 Set 防止残留旧数据
    _qqBlackSet.clear(); _qqWhiteSet.clear();
    _groupBlackSet.clear(); _groupWhiteSet.clear();
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
// ========================
export function isQQAllowed(qq) {
  if (!configData) loadConfig();
  const qqStr = String(qq);

  // 白名单优先 (利用 Set 查询 O(1))
  if (_qqWhiteSet.size > 0) {
    return _qqWhiteSet.has(qqStr);
  }
  // 无白名单时，用黑名单
  return !_qqBlackSet.has(qqStr);
}

// ========================
// 判定：指定群是否被屏蔽
// ========================
export function isGroupAllowed(groupId) {
  if (!configData) loadConfig();
  const idStr = String(groupId);

  if (_groupWhiteSet.size > 0) {
    return _groupWhiteSet.has(idStr);
  }
  return !_groupBlackSet.has(idStr);
}

// ========================
// 手动重载
// ========================
export function reloadConfig() {
  log('🔄 [配置] 正在重载...');
  return loadConfig();
}

// ========================
// 🌟 核心新增：文件变动自动监听
// ========================
function initWatcher() {
  // 初始加载一次
  loadConfig();

  try {
    // 🌟 修复：传入 { persistent: false } 防止 Node 进程因为监听文件而无法退出
    watcherInstance = fs.watch(CONFIG_PATH, { persistent: false }, (eventType) => {
      // 🌟 兼容部分编辑器：有些保存会触发 rename 事件
      if (eventType === 'change' || eventType === 'rename') {
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          log(`👀 [配置] 检测到文件变化，正在热更新...`);
          reloadConfig();
        }, 200); // 延迟 200ms 执行防抖
      }
    });
    
    log(`👀 [配置] 已开启热监听: ${CONFIG_PATH}`);
  } catch (e) {
    logErr(`❌ [配置] 监听文件失败: ${e.message}`);
  }
}

// 启动时执行一次监听挂载
initWatcher();

export default { loadConfig, getConfig, reloadConfig, isQQAllowed, isGroupAllowed };