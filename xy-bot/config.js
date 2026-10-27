// xy-bot/config.js
// ✅ 全局配置加载器

import fs from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const log = (msg) => (globalThis.print || console.log)(msg);
const logErr = (...args) => (globalThis.print || console.error)(...args);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'xy-data', 'config.yaml');

let configData = null;
let _qqBlackSet = new Set();
let _qqWhiteSet = new Set();
let _groupBlackSet = new Set();
let _groupWhiteSet = new Set();

let watchTimer = null;
let watcherInstance = null;

// 热更新防抖锁，防止编辑器保存触发多次
let isReloading = false; 

function getDefaultConfig() {
  return {
    blacklist_qq: [],
    blacklist_group: [],
    whitelist_qq: [],
    whitelist_group: [],
  };
}

function toArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

// ========================
// 加载 / 重载配置
// ========================
export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      log(`⚠️ [配置] 不存在，自动创建: ${CONFIG_PATH}`);
      const dir = dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, YAML.stringify(getDefaultConfig()), 'utf8');
    }

    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    
    // 严格检查 YAML 语法，防止写错文件导致清空配置
    const doc = YAML.parseDocument(fileContents);
    if (doc.errors && doc.errors.length > 0) {
      throw new Error(`YAML 语法错误 -> ${doc.errors[0].message}`);
    }
    const parsed = doc.toJS() || {};

    configData = {
      blacklist_qq: toArray(parsed.blacklist_qq),
      blacklist_group: toArray(parsed.blacklist_group),
      whitelist_qq: toArray(parsed.whitelist_qq),
      whitelist_group: toArray(parsed.whitelist_group),
    };

    _qqBlackSet = new Set(configData.blacklist_qq);
    _qqWhiteSet = new Set(configData.whitelist_qq);
    _groupBlackSet = new Set(configData.blacklist_group);
    _groupWhiteSet = new Set(configData.whitelist_group);

    // 详细打印，方便排错（如果名单太长可以用 join(' ') 打印）
    let logMsg = `✅ [配置] 加载成功 `;
    if (_qqWhiteSet.size > 0) logMsg += `| 白名单QQ:${_qqWhiteSet.size} `;
    if (_groupWhiteSet.size > 0) logMsg += `| 白名单群:${_groupWhiteSet.size} `;
    if (_qqBlackSet.size > 0) logMsg += `| 黑名单QQ:${_qqBlackSet.size} `;
    if (_groupBlackSet.size > 0) logMsg += `| 黑名单群:${_groupBlackSet.size} `;
    log(logMsg);

    return configData;
  } catch (e) {
    logErr(`❌ [配置] 加载失败: ${e.message}`);
    
    // 绝不清空内存中的配置，防止热更新失败导致机器人失去保护
    if (!configData) {
      logErr(`⚠️ [配置] 使用默认空配置兜底`);
      configData = getDefaultConfig();
    } else {
      logErr(`⚠️ [配置] 保留上一次的成功配置，拒绝覆盖！`);
    }
    return configData;
  }
}

export function getConfig() {
  if (!configData) loadConfig();
  return configData;
}

export function isQQAllowed(qq) {
  if (!configData) loadConfig();
  const qqStr = String(qq);
  // 白名单非空时，只允许白名单
  if (_qqWhiteSet.size > 0) return _qqWhiteSet.has(qqStr);
  // 否则放行非黑名单
  return !_qqBlackSet.has(qqStr);
}

export function isGroupAllowed(groupId) {
  if (!configData) loadConfig();
  const idStr = String(groupId);
  if (_groupWhiteSet.size > 0) return _groupWhiteSet.has(idStr);
  return !_groupBlackSet.has(idStr);
}

export function reloadConfig() {
  log('🔄 [配置] 正在重载...');
  return loadConfig();
}

// ========================
// 文件变动自动监听
// ========================
function initWatcher() {
  loadConfig();

  const startWatch = () => {
    try {
      watcherInstance = fs.watch(CONFIG_PATH, { persistent: false }, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          if (watchTimer) clearTimeout(watchTimer);
          
          watchTimer = setTimeout(() => {
            // 防止瞬间触发多次 rename
            if (isReloading) return;
            isReloading = true;

            // 检查文件是否真的存在（应对 VSCode 等编辑器先删后写的瞬间空白）
            if (fs.existsSync(CONFIG_PATH)) {
              if (eventType === 'rename' && watcherInstance) {
                try { watcherInstance.close(); } catch(e){}
                startWatch();
              }
              log(`👀 [配置] 检测到文件变化，正在热更新...`);
              reloadConfig();
            } else {
              logErr(`⚠️ [配置] 监听到文件消失，可能正在保存...`);
            }

            isReloading = false;
          }, 300); // 稍微加长一点防抖时间，应对 Windows/Mac 编辑器
        }
      });

      watcherInstance.on('error', (err) => {
        logErr(`❌ [配置] 监听器错误: ${err.message}`);
        try { watcherInstance.close(); } catch(e){}
        // 延迟 2 秒后尝试重新绑定
        setTimeout(startWatch, 2000); 
      });

    } catch (e) {
      logErr(`❌ [配置] 监听文件失败: ${e.message}`);
    }
  };

  startWatch();
  log(`👀 [配置] 已开启热监听: ${CONFIG_PATH}`);
}

// 启动监听
initWatcher();

export default { loadConfig, getConfig, reloadConfig, isQQAllowed, isGroupAllowed };