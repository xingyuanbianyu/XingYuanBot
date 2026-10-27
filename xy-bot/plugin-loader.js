import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';

const PLUGINS_DIR = resolve(process.cwd(), 'xy-plugins');
const log = (msg) => (globalThis.print || console.log)(msg);

let _loaded = false;
let _pluginsCache = null;

const pluginHandlers = new Map();     
const eventRegistrations = new Map(); 
const pluginCacheMap = new Map();

// 🌟 核心修改 1：删除了 globalCodeCounter，不再使用全局计数

const pluginKeyOf = (category, name) => `${category}/${name}`;

// ============================================================
// 🌟 计算文件内容的 SHA256 指纹（带 stat 预检优化）
// ============================================================
function getFileHash(filePath) {
    try {
        const buffer = readFileSync(filePath);
        return createHash('sha256').update(buffer).digest('hex');
    } catch (e) {
        return null;
    }
}

// ============================================================
// 事件监听器
// ============================================================
function makeListener(pluginKey, eventName) {
  return async (payload) => {
    const current = pluginHandlers.get(pluginKey);
    if (!current || typeof current.onEvent !== 'function') return;
    try {
      await current.onEvent({ event: eventName, ...payload }, { ws: null });
    } catch (err) {
      console.error(`❌ [事件插件报错] ${pluginKey} -> ${eventName}:\n${err.stack || err.message}`);
    }
  };
}

function bindHandler(pluginKey, handler) {
  pluginHandlers.set(pluginKey, handler);
}

function syncEventListeners(pluginKey, handler, adapterRegistry) {
  pluginHandlers.set(pluginKey, handler);
  if (!adapterRegistry) return;

  if (!Array.isArray(handler?.events) || typeof handler.onEvent !== 'function') {
    if (eventRegistrations.has(pluginKey)) detachPlugin(pluginKey, true);
    return;
  }

  const newEvents = new Set(handler.events);
  const regs = eventRegistrations.get(pluginKey) ?? new Map();

  for (const adapter of adapterRegistry.list.values()) {
    if (typeof adapter.onEvent !== 'function') continue;
    const adapterRegs = regs.get(adapter) ?? new Map();

    for (const [ev, listener] of adapterRegs) {
      if (!newEvents.has(ev)) {
        try { adapter.offEvent?.(ev, listener); } catch {}
        adapterRegs.delete(ev);
      }
    }
    for (const ev of newEvents) {
      if (adapterRegs.has(ev)) continue;
      const listener = makeListener(pluginKey, ev);
      adapter.onEvent(ev, listener);
      adapterRegs.set(ev, listener);
    }
    regs.set(adapter, adapterRegs);
  }
  eventRegistrations.set(pluginKey, regs);
}

function detachPlugin(pluginKey, keepHandler = false) {
  const regs = eventRegistrations.get(pluginKey);
  if (regs) {
    for (const [adapter, adapterRegs] of regs) {
      for (const [ev, listener] of adapterRegs) {
        try { adapter.offEvent?.(ev, listener); } catch {}
      }
    }
    eventRegistrations.delete(pluginKey);
  }
  if (!keepHandler) {
    pluginHandlers.delete(pluginKey);
    pluginCacheMap.delete(pluginKey);
  }
}

async function importPluginModule(entryPath) {
  const moduleURL = pathToFileURL(entryPath).href;
  const cacheBustURL = moduleURL + '?t=' + Date.now(); 
  const mod = await import(cacheBustURL);
  return mod.default ?? mod;
}

// ============================================================
// 扫描目录 + 增量加载
// ============================================================
async function scanAndLoadAll(adapterRegistry) {
  const plugins = [];
  const errors = [];
  const loadLog = [];

  if (!existsSync(PLUGINS_DIR)) {
    return { plugins, errors: ['插件总目录不存在'], log: [] };
  }

  const categoryDirs = readdirSync(PLUGINS_DIR)
    .filter(n => statSync(join(PLUGINS_DIR, n)).isDirectory())
    .sort();

  const currentPluginKeys = new Set(); 

  for (const catName of categoryDirs) {
    const catDir = join(PLUGINS_DIR, catName);
    const pluginDirs = readdirSync(catDir)
      .filter(n => statSync(join(catDir, n)).isDirectory())
      .sort();

    const stat = { category: catName, total: pluginDirs.length, loaded: 0, updated: 0, skipped: 0, failed: 0, reused: 0 };
    loadLog.push(stat);

    for (const dirName of pluginDirs) {
      const pluginPath = join(catDir, dirName);
      const rulePath = join(pluginPath, 'rule.json');
      const entryPath = join(pluginPath, 'index.js');
      const pluginKey = pluginKeyOf(catName, dirName);

      currentPluginKeys.add(pluginKey);

      if (!existsSync(rulePath) || !existsSync(entryPath)) {
        stat.skipped++;
        continue;
      }

      try {
        const entryHash = getFileHash(entryPath);
        const ruleHash = getFileHash(rulePath);
        
        const rule = JSON.parse(readFileSync(rulePath, 'utf-8'));
        if (rule.enabled === false) {
          stat.skipped++;
          detachPlugin(pluginKey); 
          currentPluginKeys.delete(pluginKey);
          continue;
        }

        const cached = pluginCacheMap.get(pluginKey);
        
        if (cached && cached.entryHash === entryHash && cached.ruleHash === ruleHash) {
          plugins.push({ category: catName, name: dirName, rule, handler: cached.handler, code: cached.code });
          bindHandler(pluginKey, cached.handler);
          stat.reused++; 
          continue; 
        }

        const isNew = !cached;
        const handler = await importPluginModule(entryPath);

        // 🌟 核心修改 2：基于自身旧代号 +1，首次加载给 0
        let currentCode = 0;
        if (isNew) {
            currentCode = 0;
        } else {
            currentCode = (cached.code || 0) + 1;
        }

        pluginCacheMap.set(pluginKey, {
          code: currentCode,
          entryHash: entryHash,
          ruleHash: ruleHash,
          handler: handler,
          rule: rule
        });

        bindHandler(pluginKey, handler);
        plugins.push({ category: catName, name: dirName, rule, handler, code: currentCode });
        
        if (isNew) {
          stat.loaded++;
          log(`✅ 插件 [${catName}/${dirName}] 首次加载成功 (代号: ${currentCode})`);
        } else {
          stat.updated++;
          log(`🔄 插件 [${catName}/${dirName}] 发现内容变更，已增量更新 (新代号: ${currentCode})`);
        }
      } catch (e) {
        log(`❌ 插件 [${catName}/${dirName}] 加载失败:\n${e.stack || e.message}`);
        errors.push(`${catName}/${dirName}: ${e.message}`);
        stat.failed++;
      }
    }
  }

  for (const oldKey of Array.from(pluginCacheMap.keys())) {
    if (!currentPluginKeys.has(oldKey)) {
      log(`🗑️ 插件 [${oldKey}] 已被物理删除，正在卸载...`);
      detachPlugin(oldKey);
    }
  }

  return { plugins, errors, log: loadLog };
}

export async function loadPlugins(adapterRegistry = null) {
  if (_loaded) return _pluginsCache;
  const cache = await scanAndLoadAll(adapterRegistry);
  for (const p of cache.plugins) {
    syncEventListeners(pluginKeyOf(p.category, p.name), p.handler, adapterRegistry);
  }
  _pluginsCache = cache;
  _loaded = true;
  return _pluginsCache;
}

// ============================================================
// 单插件热重载
// ============================================================
export async function hotReloadPlugin(pluginNames, adapterRegistry) {
  if (!_pluginsCache) return;
  const plugins = _pluginsCache.plugins;
  const targets = Array.isArray(pluginNames) ? pluginNames : [pluginNames];

  log(`🔄 开始强制热重载插件: [${targets.join(', ')}]`);

  for (const name of targets) {
    const p = plugins.find(x => x.name === name);
    if (!p) {
      log(`⚠️ 未找到名为 ${name} 的插件，跳过重载。`);
      continue;
    }

    const entryPath = join(PLUGINS_DIR, p.category, p.name, 'index.js');
    const rulePath = join(PLUGINS_DIR, p.category, p.name, 'rule.json');
    const pluginKey = pluginKeyOf(p.category, p.name);

    try {
      const entryHash = getFileHash(entryPath);
      const ruleHash = getFileHash(rulePath);
      const cached = pluginCacheMap.get(pluginKey);
      
      if (cached && cached.entryHash === entryHash && cached.ruleHash === ruleHash) {
          log(`♻️ 插件 ${name} 内容未发生修改，跳过强制编译，保持原代号: ${cached.code}`);
          continue;
      }

      log(`⏳ 正在编译新代码: ${name}...`);
      const handler = await importPluginModule(entryPath);

      if (typeof p.handler?.destroy === 'function') {
        try { await p.handler.destroy(); } catch (e) { log(`⚠️ 插件 ${name} 的 destroy 执行异常: ${e.message}`); }
      }

      const oldEvents = new Set(p.handler?.events ?? []);
      const newEvents = new Set(handler?.events ?? []);
      const eventsChanged = oldEvents.size !== newEvents.size || [...newEvents].some(ev => !oldEvents.has(ev));

      // 🌟 核心修改 3：取缓存中的当前代号 +1
      const currentCode = (cached?.code || 0) + 1;

      p.handler = handler;
      p.code = currentCode;
      pluginCacheMap.set(pluginKey, {
        code: currentCode,
        entryHash: entryHash,
        ruleHash: ruleHash,
        handler: handler,
        rule: p.rule
      });

      if (eventsChanged) {
        syncEventListeners(pluginKey, handler, adapterRegistry);
      } else {
        bindHandler(pluginKey, handler);
      }

      log(`✅ 插件 ${name} 热重载成功！(新代号: ${currentCode})`);
    } catch (e) {
      log(`❌ 插件 ${name} 热重载失败，已保留旧版本:\n${e.stack || e.message}`);
    }
  }
}

// ============================================================
// 全量热重载
// ============================================================
export async function reloadAllPlugins(adapterRegistry = null) {
  log('🔄 开始全量增量热重载...');

  const oldPlugins = _pluginsCache?.plugins ?? [];
  for (const p of oldPlugins) {
    if (typeof p.handler?.destroy === 'function') {
      try { await p.handler.destroy(); } catch (e) { log(`⚠️ 插件 ${p.name} destroy 异常: ${e.message}`); }
    }
  }

  const newCache = await scanAndLoadAll(adapterRegistry);

  for (const p of newCache.plugins) {
    const pluginKey = pluginKeyOf(p.category, p.name);
    const oldP = oldPlugins.find(x => x.category === p.category && x.name === p.name);
    
    if (!oldP) {
      syncEventListeners(pluginKey, p.handler, adapterRegistry);
    } else {
      const oldEvents = new Set(oldP.handler?.events ?? []);
      const newEvents = new Set(p.handler?.events ?? []);
      const eventsChanged = oldEvents.size !== newEvents.size || [...newEvents].some(ev => !oldEvents.has(ev));
      if (eventsChanged) {
        syncEventListeners(pluginKey, p.handler, adapterRegistry);
      } else {
        bindHandler(pluginKey, p.handler);
      }
    }
  }

  if (_pluginsCache) {
    _pluginsCache.plugins = newCache.plugins;
    _pluginsCache.log = newCache.log;
    _pluginsCache.errors = newCache.errors;
  } else {
    _pluginsCache = newCache;
  }
  _loaded = true;

  log(`✅ 全量增量热重载完成，当前共 ${newCache.plugins.length} 个插件`);
  return _pluginsCache;
}

export function clearPluginCache() {
  for (const key of Array.from(eventRegistrations.keys())) detachPlugin(key);
  pluginHandlers.clear();
  pluginCacheMap.clear();
  _loaded = false;
  _pluginsCache = null;
}