import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'node:path';
import { pathToFileURL } from 'url';

const PLUGINS_DIR = './xy-plugins';

let _loaded = false;
let _pluginsCache = null;

export async function loadPlugins(adapterRegistry = null) {
  console.log('🔵 loadPlugins 被调用, _loaded=' + _loaded);
  if (_loaded) return _pluginsCache;

  const plugins = [];
  const errors = [];
  const loadLog = [];

  if (!existsSync(PLUGINS_DIR)) {
    const msg = `插件总目录不存在: ${PLUGINS_DIR}`;
    console.error(`❌ ${msg}`);
    _loaded = true;
    _pluginsCache = { plugins: [], errors: [msg], log: [] };
    return _pluginsCache;
  }

  // 第一层：遍历总目录（QQ/、通用/、WeChat/ 等）
  const categoryDirs = readdirSync(PLUGINS_DIR).filter(n => {
    const p = join(PLUGINS_DIR, n);
    return statSync(p).isDirectory();
  });

  console.log(`📁 发现 ${categoryDirs.length} 个插件总目录: ${categoryDirs.join(', ')}`);

  // 第二层：遍历每个总目录下的具体插件
  for (const catName of categoryDirs) {
    const catDir = join(PLUGINS_DIR, catName);

    const pluginDirs = readdirSync(catDir).filter(n => {
      const p = join(catDir, n);
      return statSync(p).isDirectory();
    });

    loadLog.push({ category: catName, total: pluginDirs.length, loaded: 0, skipped: 0, failed: 0 });

    for (const dirName of pluginDirs) {
      const pluginPath = join(catDir, dirName);
      const rulePath = join(pluginPath, 'rule.json');

      if (!existsSync(rulePath)) {
        console.log(`⚠️ 插件 [${catName}/${dirName}] 缺少 rule.json，跳过`);
        errors.push(`[${catName}/${dirName}] 缺少 rule.json`);
        loadLog[loadLog.length - 1].skipped++;
        continue;
      }

      let rule;
      try {
        rule = JSON.parse(readFileSync(rulePath, 'utf-8'));
      } catch (e) {
        const msg = `插件 [${catName}/${dirName}] rule.json 解析失败: ${e.message}`;
        console.error(`❌ ${msg}`);
        errors.push(`[${catName}/${dirName}] rule.json 解析失败: ${e.message}`);
        loadLog[loadLog.length - 1].failed++;
        continue;
      }

      // 🌟 核心新增：判断是否启用！
      // 兼容 enabled 和 enable 两种写法，只要显式为 false，就直接跳过
      if (rule.enabled === false || rule.enable === false) {
        console.log(`⏸️ 插件 [${catName}/${dirName}] 已被禁用，跳过加载`);
        loadLog[loadLog.length - 1].skipped++;
        continue; 
      }

      const entryFile = rule.entry || 'index.js';
      const entryPath = join(pluginPath, entryFile);

      if (!existsSync(entryPath)) {
        const msg = `插件 [${catName}/${dirName}] 入口文件 ${entryFile} 不存在，跳过`;
        console.log(`⚠️ ${msg}`);
        errors.push(`[${catName}/${dirName}] 入口文件 ${entryFile} 不存在`);
        loadLog[loadLog.length - 1].failed++;
        continue;
      }

      try {
        const moduleURL = pathToFileURL(entryPath).href;
        const cacheBustURL = moduleURL + '?t=' + Date.now();
        const mod = await import(cacheBustURL);
        console.log(`✅ 正在加载: ${catName}/${dirName}`);

        const handler = mod.default ?? mod;

        // 🌟 核心修复：加载的同时，直接顺手把事件订阅了！
        if (adapterRegistry && handler.events && typeof handler.onEvent === 'function') {
          const adapterList = Array.from(adapterRegistry.list.values());
          let subscribed = false;
          for (const eventName of handler.events) {
            for (const adapter of adapterList) {
              if (typeof adapter.onEvent === 'function') {
                adapter.onEvent(eventName, async (payload) => {
                  // 注入 event 字段，让插件里能通过 e.event 识别具体事件
                  const eventData = { event: eventName, ...payload };
                  try {
                    await handler.onEvent(eventData, { ws: globalThis._ws });
                  } catch (err) {
                    console.error(`❌ [事件插件报错] ${dirName} -> ${eventName}:`, err.message);
                  }
                });
                subscribed = true;
              }
            }
          }
          if (subscribed) {
            console.log(`✅ 插件 [${catName}/${dirName}] 已自动订阅事件: [${handler.events.join(', ')}]`);
          }
        }

        plugins.push({
          category: catName,
          name: dirName,
          rule,
          handler: handler
        });

        loadLog[loadLog.length - 1].loaded++;
        console.log(`✅ 插件 [${catName}/${dirName}] 加载成功`);
      } catch (e) {
        const msg = `插件 [${catName}/${dirName}] 加载失败: ${e.message}`;
        console.error(`❌ ${msg}`);
        errors.push(`[${catName}/${dirName}] 加载失败: ${e.message}`);
        loadLog[loadLog.length - 1].failed++;
      }
    }
  }

  // 打印汇总日志
  console.log('\n========== 插件加载汇总 ==========');
  let grandTotal = 0, grandLoaded = 0, grandFailed = 0;
  for (const log of loadLog) {
    console.log(`  📁 ${log.category}: 共 ${log.total} 个 | ✅ ${log.loaded} | ⚠️ ${log.skipped} | ❌ ${log.failed}`);
    grandTotal += log.total;
    grandLoaded += log.loaded;
    grandFailed += log.failed;
  }
  console.log(`  总计: ${grandTotal} 个插件, 成功 ${grandLoaded}, 跳过 ${grandTotal - grandLoaded - grandFailed}, 失败 ${grandFailed}`);
  console.log('==================================\n');

  _loaded = true;
  _pluginsCache = { plugins, errors, log: loadLog };
  return _pluginsCache;
}

export function clearPluginCache() {
  console.log('🔴 clearPluginCache 被调用了');
  _loaded = false;
  _pluginsCache = null;
}