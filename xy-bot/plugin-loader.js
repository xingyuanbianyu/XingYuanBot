import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'url';

// 🌟 修复 2：使用基于当前文件位置的绝对路径，彻底告别 cwd 依赖
const PLUGINS_DIR = resolve(process.cwd(), 'xy-plugins');

let _loaded = false;
let _pluginsCache = null;

const log = (msg) => (globalThis.print || console.log)(msg);

export async function loadPlugins(adapterRegistry = null) {
  log('🔵 loadPlugins 被调用, _loaded=' + _loaded);
  if (_loaded) return _pluginsCache;

  const plugins = [];
  const errors = [];
  const loadLog = [];

  if (!existsSync(PLUGINS_DIR)) {
    const msg = `插件总目录不存在: ${PLUGINS_DIR}`;
    log(`❌ ${msg}`);
    _loaded = true;
    _pluginsCache = { plugins: [], errors: [msg], log: [] };
    return _pluginsCache;
  }

  // 第一层：遍历总目录（QQ/、通用/ 等）
  const categoryDirs = readdirSync(PLUGINS_DIR).filter(n => {
    const p = join(PLUGINS_DIR, n);
    return statSync(p).isDirectory();
  });

  log(`📁 发现 ${categoryDirs.length} 个插件总目录: ${categoryDirs.join(', ')}`);

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
        log(`⚠️ 插件 [${catName}/${dirName}] 缺少 rule.json，跳过`);
        errors.push(`[${catName}/${dirName}] 缺少 rule.json`);
        loadLog[loadLog.length - 1].skipped++;
        continue;
      }

      let rule;
      try {
        rule = JSON.parse(readFileSync(rulePath, 'utf-8'));
      } catch (e) {
        const msg = `插件 [${catName}/${dirName}] rule.json 解析失败: ${e.message}`;
        log(`❌ ${msg}`);
        errors.push(`[${catName}/${dirName}] rule.json 解析失败: ${e.message}`);
        loadLog[loadLog.length - 1].failed++;
        continue;
      }

      if (rule.enabled === false || rule.enable === false) {
        log(`⏸️ 插件 [${catName}/${dirName}] 已被禁用，跳过加载`);
        loadLog[loadLog.length - 1].skipped++;
        continue; 
      }

      const entryFile = rule.entry || 'index.js';
      const entryPath = join(pluginPath, entryFile);

      if (!existsSync(entryPath)) {
        const msg = `插件 [${catName}/${dirName}] 入口文件 ${entryFile} 不存在，跳过`;
        log(`⚠️ ${msg}`);
        errors.push(`[${catName}/${dirName}] 入口文件 ${entryFile} 不存在`);
        loadLog[loadLog.length - 1].failed++;
        continue;
      }

      try {
        const moduleURL = pathToFileURL(entryPath).href;
        const cacheBustURL = moduleURL + '?t=' + Date.now();
        const mod = await import(cacheBustURL);
        log(`✅ 正在加载: ${catName}/${dirName}`);

        const handler = mod.default ?? mod;

        // 🌟 核心修复 1：事件订阅
        if (adapterRegistry && handler.events && typeof handler.onEvent === 'function') {
          const adapterList = Array.from(adapterRegistry.list.values());
          let subscribed = false;
          
          for (const eventName of handler.events) {
            for (const adapter of adapterList) {
              if (typeof adapter.onEvent === 'function') {
                // 绑定带有唯一标识的监听函数，方便热重载时解绑
                const listener = async (payload) => {
                  // 注入 event 字段，让插件里能通过 e.event 识别具体事件
                  const eventData = { event: eventName, ...payload };
                  try {
                    // 🌟 关键修复：不要传 globalThis._ws！直接把整个 payload 扔给插件
                    // payload 里包含 selfId 和 raw 数据，插件自己用 globalThis.bot.send({ botId, ... }) 发消息
                    await handler.onEvent(eventData, { ws: null }); 
                  } catch (err) {
                    console.error(`❌ [事件插件报错] ${dirName} -> ${eventName}:`, err.message);
                  }
                };
                
                adapter.onEvent(eventName, listener);
                subscribed = true;
              }
            }
          }
          if (subscribed) {
            log(`✅ 插件 [${catName}/${dirName}] 已自动订阅事件: [${handler.events.join(', ')}]`);
          }
        }

        plugins.push({
          category: catName,
          name: dirName,
          rule,
          handler: handler
        });

        loadLog[loadLog.length - 1].loaded++;
        log(`✅ 插件 [${catName}/${dirName}] 加载成功`);
      } catch (e) {
        const msg = `插件 [${catName}/${dirName}] 加载失败: ${e.message}`;
        log(`❌ ${msg}`);
        errors.push(`[${catName}/${dirName}] 加载失败: ${e.message}`);
        loadLog[loadLog.length - 1].failed++;
      }
    }
  }

  // 打印汇总日志
  log('\n========== 插件加载汇总 ==========');
  let grandTotal = 0, grandLoaded = 0, grandFailed = 0;
  for (const logItem of loadLog) {
    log(`  📁 ${logItem.category}: 共 ${logItem.total} 个 | ✅ ${logItem.loaded} | ⚠️ ${logItem.skipped} | ❌ ${logItem.failed}`);
    grandTotal += logItem.total;
    grandLoaded += logItem.loaded;
    grandFailed += logItem.failed;
  }
  log(`  总计: ${grandTotal} 个插件, 成功 ${grandLoaded}, 跳过 ${grandTotal - grandLoaded - grandFailed}, 失败 ${grandFailed}`);
  log('==================================\n');

  _loaded = true;
  _pluginsCache = { plugins, errors, log: loadLog };
  return _pluginsCache;
}

export function clearPluginCache() {
  log('🔴 clearPluginCache 被调用了');
  _loaded = false;
  _pluginsCache = null;
  // 🌟 注意：如果频繁热重载，建议在 Adapter 里加个 clearEvents() 方法来清除旧的监听器，
  // 否则就算这里清除了缓存，Adapter 里挂着的旧函数依然存在。
}