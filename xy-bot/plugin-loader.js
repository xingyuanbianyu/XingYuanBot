// xy-bot/plugin-loader.js

import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, dirname, resolve, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';

// ========================
// 定位插件根目录（基于本文件位置）
// ========================
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');       // 从 xy-bot/ 上一级拿到项目根目录
const PLUGINS_DIR = join(PROJECT_ROOT, 'xy-plugins');

// ========================
// 支持的规则文件名（按优先级）
// ========================
const RULE_FILENAMES = ['rule.json', 'plugin.json', 'manifest.json'];

// ========================
// 缓存
// ========================
let _loaded = false;
let _pluginsCache = null;

// ========================
// 工具：读取插件的规则文件
// ========================
function readRule(pluginPath) {
  for (const name of RULE_FILENAMES) {
    const rulePath = join(pluginPath, name);
    if (!existsSync(rulePath)) continue;

    try {
      const rule = JSON.parse(readFileSync(rulePath, 'utf-8'));
      // 兼容：entry 默认 index.js
      rule.__ruleFile = name;
      return rule;
    } catch (e) {
      throw new Error(`${name} 解析失败: ${e.message}`);
    }
  }
  return null; // 没有规则文件
}

// ========================
// 工具：定位入口文件
// ========================
function resolveEntry(pluginPath, rule) {
  // 1. rule.entry 显式指定
  if (rule.entry) {
    const entryPath = join(pluginPath, rule.entry);
    if (existsSync(entryPath)) return entryPath;
    // rule.entry 是目录名，尝试找 index.js
    if (existsSync(join(entryPath, 'index.js'))) return join(entryPath, 'index.js');
    return null;
  }

  // 2. 默认尝试 index.js / main.js
  for (const name of ['index.js', 'main.js']) {
    const p = join(pluginPath, name);
    if (existsSync(p)) return p;
  }

  // 3. 目录里只有一个 .js 文件时，直接用它
  const jsFiles = readdirSync(pluginPath).filter(f => f.endsWith('.js'));
  if (jsFiles.length === 1) return join(pluginPath, jsFiles[0]);

  return null;
}

// ========================
// 递归查找所有「插件目录」
// 判定标准：目录里存在 RULE_FILENAMES 之一
// ========================
function scanPluginDirs(rootDir, maxDepth = 4) {
  const result = []; // { pluginPath, category, dirName, relative }

  function walk(currentDir, depth, categoryPath) {
    if (depth > maxDepth) return;
    if (!existsSync(currentDir)) return;

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    // 本目录是不是插件？
    const hasRule = entries.some(
      d => d.isFile() && RULE_FILENAMES.includes(d.name)
    );

    if (hasRule) {
      result.push({
        pluginPath: currentDir,
        relative: currentDir.slice(PLUGINS_DIR.length + 1).replace(/\\/g, '/'),
        dirName: basename(currentDir),
        category: categoryPath[0] || '未分类',
      });
      return; // 已识别为插件，不再往下钻（避免把插件的内部子目录也当成插件）
    }

    // 否则继续递归
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(join(currentDir, entry.name), depth + 1, [...categoryPath, entry.name]);
    }
  }

  walk(rootDir, 0, []);
  return result;
}

// ========================
// 主入口：加载所有插件
// ========================
export async function loadPlugins(options = {}) {
  const forceReload = options.force === true;

  if (_loaded && !forceReload) return _pluginsCache;

  console.log(`🔵 [插件加载] 扫描目录: ${PLUGINS_DIR}`);

  const plugins = [];
  const errors = [];
  const loadLog = []; // 按 category 分组统计

  if (!existsSync(PLUGINS_DIR)) {
    const msg = `插件总目录不存在: ${PLUGINS_DIR}`;
    console.error(`❌ ${msg}`);
    _loaded = true;
    _pluginsCache = { plugins: [], errors: [msg], log: [] };
    return _pluginsCache;
  }

  // 1. 扫描所有插件目录
  const pluginDirs = scanPluginDirs(PLUGINS_DIR);
  console.log(`📁 发现 ${pluginDirs.length} 个候选插件目录`);

  // 2. 按 category 分组，统计用
  const logMap = new Map();

  // 3. 逐个加载
  for (const info of pluginDirs) {
    const { pluginPath, relative, dirName, category } = info;

    if (!logMap.has(category)) {
      logMap.set(category, { category, total: 0, loaded: 0, skipped: 0, failed: 0 });
    }
    const log = logMap.get(category);
    log.total++;

    // --- 读取规则 ---
    let rule;
    try {
      rule = readRule(pluginPath);
    } catch (e) {
      const msg = `[${relative}] 规则文件错误: ${e.message}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
      log.failed++;
      continue;
    }

    if (!rule) {
      // 理论上 scanPluginDirs 已经过滤，这里只是保险
      const msg = `[${relative}] 未找到规则文件`;
      console.warn(`⚠️ ${msg}`);
      errors.push(msg);
      log.skipped++;
      continue;
    }

    // --- 检查 enabled ---
    if (rule.enabled === false || rule.enable === false) {
      console.log(`⏸️ [${relative}] 已被规则禁用，跳过`);
      log.skipped++;
      continue;
    }

    // --- 定位入口 ---
    const entryPath = resolveEntry(pluginPath, rule);
    if (!entryPath) {
      const msg = `[${relative}] 找不到入口文件（rule.entry=${rule.entry || '未指定'}）`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
      log.failed++;
      continue;
    }

    // --- 动态 import ---
    try {
      const moduleURL = pathToFileURL(entryPath).href;
      const cacheBustURL = moduleURL + '?t=' + Date.now();
      const mod = await import(cacheBustURL);

      const handler = mod.default ?? mod;

      plugins.push({
        category,
        name: rule.name || dirName,
        path: pluginPath,           // ⭐ 插件自己的绝对路径
        entry: entryPath,           // ⭐ 入口文件的绝对路径
        rule,
        handler,
      });

      log.loaded++;
      console.log(`✅ [${relative}] 加载成功 (${basename(entryPath)})`);
    } catch (e) {
      const msg = `[${relative}] 加载失败: ${e.message}`;
      console.error(`❌ ${msg}`);
      console.error(e.stack?.split('\n').slice(0, 3).join('\n')); // 打印前3行堆栈
      errors.push(msg);
      log.failed++;
    }
  }

  // 4. 打印汇总
  console.log('\n========== 插件加载汇总 ==========');
  let grandTotal = 0, grandLoaded = 0, grandFailed = 0, grandSkipped = 0;
  for (const log of logMap.values()) {
    console.log(`  📁 ${log.category}: 共 ${log.total} | ✅ ${log.loaded} | ⏸️ ${log.skipped} | ❌ ${log.failed}`);
    loadLog.push(log);
    grandTotal += log.total;
    grandLoaded += log.loaded;
    grandSkipped += log.skipped;
    grandFailed += log.failed;
  }
  console.log(`  总计: ${grandTotal} 个插件, 成功 ${grandLoaded}, 禁用/跳过 ${grandSkipped}, 失败 ${grandFailed}`);
  console.log('==================================\n');

  // 5. 缓存（只有全部成功才缓存；有失败也缓存但标记可重载）
  _loaded = true;
  _pluginsCache = { plugins, errors, log: loadLog };

  return _pluginsCache;
}

// ========================
// 清空缓存（下次 loadPlugins 会重新扫）
// ========================
export function clearPluginCache() {
  console.log('🔴 [插件加载] 缓存已清空');
  _loaded = false;
  _pluginsCache = null;
}

// ========================
// 对外暴露插件根目录，方便其他模块使用
// ========================
export function getPluginsDir() {
  return PLUGINS_DIR;
}