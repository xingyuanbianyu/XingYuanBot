import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'url';

const PLUGINS_DIR = resolve(process.cwd(), 'xy-plugins');
const log = (msg) => (globalThis.print || console.log)(msg);

let _loaded = false;
let _pluginsCache = null;
// 记录已经挂载的事件监听器，用于热重载时清理旧监听器
const activeListeners = new Map(); // key: adapter, value: [{ event, listener }]

export async function loadPlugins(adapterRegistry = null) {
  if (_loaded) return _pluginsCache;

  const plugins = [];
  const errors = [];
  const loadLog = [];

  if (!existsSync(PLUGINS_DIR)) {
    _loaded = true;
    _pluginsCache = { plugins: [], errors: ['插件总目录不存在'], log: [] };
    return _pluginsCache;
  }

  const categoryDirs = readdirSync(PLUGINS_DIR).filter(n => statSync(join(PLUGINS_DIR, n)).isDirectory());

  for (const catName of categoryDirs) {
    const catDir = join(PLUGINS_DIR, catName);
    const pluginDirs = readdirSync(catDir).filter(n => statSync(join(catDir, n)).isDirectory());

    loadLog.push({ category: catName, total: pluginDirs.length, loaded: 0, skipped: 0, failed: 0 });

    for (const dirName of pluginDirs) {
      const pluginPath = join(catDir, dirName);
      const rulePath = join(pluginPath, 'rule.json');
      const entryPath = join(pluginPath, 'index.js');

      if (!existsSync(rulePath) || !existsSync(entryPath)) {
        loadLog[loadLog.length - 1].skipped++;
        continue;
      }

      try {
        const rule = JSON.parse(readFileSync(rulePath, 'utf-8'));
        if (rule.enabled === false) {
            loadLog[loadLog.length - 1].skipped++;
            continue;
        }

        const handler = await loadSinglePlugin(entryPath, adapterRegistry);

        plugins.push({ category: catName, name: dirName, rule, handler });
        loadLog[loadLog.length - 1].loaded++;
        log(`✅ 插件 [${catName}/${dirName}] 加载成功`);
      } catch (e) {
        log(`❌ 插件 [${catName}/${dirName}] 加载失败: ${e.message}`);
        loadLog[loadLog.length - 1].failed++;
      }
    }
  }

  _loaded = true;
  _pluginsCache = { plugins, errors, log: loadLog };
  return _pluginsCache;
}

// 🌟 单独加载某个插件，并处理事件订阅
async function loadSinglePlugin(entryPath, adapterRegistry) {
    // 1. 加上时间戳破除 ESM 缓存，加载一个全新的实例
    const moduleURL = pathToFileURL(entryPath).href;
    const cacheBustURL = moduleURL + '?t=' + Date.now();
    const mod = await import(cacheBustURL);
    const handler = mod.default ?? mod;

    // 2. 处理事件订阅 (如果插件声明了 events 和 onEvent)
    if (adapterRegistry && handler.events && typeof handler.onEvent === 'function') {
        const adapterList = Array.from(adapterRegistry.list.values());
        
        for (const eventName of handler.events) {
            for (const adapter of adapterList) {
                if (typeof adapter.onEvent === 'function') {
                    // 创建监听器
                    const listener = async (payload) => {
                        try {
                            const eventData = { event: eventName, ...payload };
                            await handler.onEvent(eventData, { ws: null });
                        } catch (err) {
                            console.error(`❌ [事件插件报错] ${entryPath} -> ${eventName}:`, err.message);
                        }
                    };

                    // 记录下这个监听器，方便以后删除
                    if (!activeListeners.has(adapter)) activeListeners.set(adapter, []);
                    activeListeners.get(adapter).push({ event: eventName, listener });

                    // 注册
                    adapter.onEvent(eventName, listener);
                }
            }
        }
    }
    return handler;
}

/**
 * 🌟 终极原子热重载方法
 * 不重启整个机器人，只安全地替换指定的一个或多个插件
 */
export async function hotReloadPlugin(pluginNames, adapterRegistry) {
    if (!_pluginsCache) return;
    const oldPlugins = _pluginsCache.plugins;
    const targetNames = Array.isArray(pluginNames) ? pluginNames : [pluginNames];

    log(`🔄 开始热重载插件: [${targetNames.join(', ')}]`);

    for (const targetName of targetNames) {
        // 1. 找到旧插件的索引
        const index = oldPlugins.findIndex(p => p.name === targetName);
        if (index === -1) {
            log(`⚠️ 未找到名为 ${targetName} 的插件，跳过重载。`);
            continue;
        }

        const oldPlugin = oldPlugins[index];
        const entryPath = join(PLUGINS_DIR, oldPlugin.category, oldPlugin.name, 'index.js');

        try {
            // 2. 先尝试加载新版本（原子性：如果不成功，直接抛错，不影响旧的）
            log(`⏳ 正在编译新代码: ${targetName}...`);
            const newHandler = await loadSinglePlugin(entryPath, adapterRegistry);

            // 3. 销毁旧插件
            log(`🧹 清理旧实例: ${targetName}...`);
            
            // 3.1 如果旧插件有自定义的清理逻辑（比如清理定时器），调用它
            if (typeof oldPlugin.handler.destroy === 'function') {
                await oldPlugin.handler.destroy();
            }

            // 3.2 从适配器中拔除旧插件的事件监听
            if (adapterRegistry) {
                const adapterList = Array.from(adapterRegistry.list.values());
                for (const adapter of adapterList) {
                    if (activeListeners.has(adapter)) {
                        const listeners = activeListeners.get(adapter);
                        // 过滤掉属于这个旧插件的监听器
                        // （注意：这里为了简单，清空该适配器下所有属于此插件的事件，实际工程中可以给 listener 打标签）
                        // 为了安全，我们直接清空这个插件注册过的所有事件
                        if (typeof adapter.offEvent === 'function') {
                            // 如果 Adapter 有 offEvent
                            for (const evName of (oldPlugin.handler.events || [])) {
                                adapter.offEvent(evName); // 需要你在 adapter 里实现
                            }
                        } else {
                            // 如果没有 offEvent，只能通过内部 Map 覆写，但这会导致旧的依然残留。
                            // 这就是为什么我们要自己管理 activeListeners
                            for (const item of listeners) {
                                if (item.listener.toString().includes(entryPath) && adapter.eventHandlers) {
                                    adapter.eventHandlers.get(item.event)?.delete(item.listener);
                                }
                            }
                        }
                    }
                }
            }

            // 4. 替换缓存中的对象
            oldPlugins[index].handler = newHandler;
            log(`✅ 插件 ${targetName} 热重载成功！`);

        } catch (e) {
            // 如果加载新模块时抛错，直接捕获。旧模块依然在正常运作（原子性保证）
            log(`❌ 插件 ${targetName} 热重载失败，已保留旧版本: ${e.message}`);
        }
    }
}

export function clearPluginCache() {
  _loaded = false;
  _pluginsCache = null;
}