import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const log = (msg) => (globalThis.print || console.log)(msg);
const logErr = (msg) => (globalThis.print || console.error)(msg);

export class AdapterRegistry {
  constructor() {
    this.list = new Map();
  }

  /**
   * 扫描适配器目录
   */
  async scan(adaptersDir, hotReload = false) {
    if (!existsSync(adaptersDir)) return;

    const validAdapterNames = new Set();

    for (const entry of readdirSync(adaptersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('_') || entry.name.endsWith('.disabled')) continue;

      const adapterPath = join(adaptersDir, entry.name);
      const cfgPath = join(adapterPath, 'adapter.json');

      if (!existsSync(cfgPath)) continue;

      try {
        const meta = JSON.parse(readFileSync(cfgPath, 'utf8'));
        
        if (!meta.name) {
          logErr(`⚠️ [适配器] ${entry.name}/adapter.json 缺少 "name" 字段，已跳过`);
          continue;
        }

        validAdapterNames.add(meta.name);

        // 🌟 修复 1：如果是热重载，允许覆盖旧的适配器实例
        if (this.list.has(meta.name)) {
            if (!hotReload) {
                logErr(`⚠️ [适配器] 发现同名适配器 [${meta.name}]，将被忽略: ${entry.name}`);
                continue;
            }
        }

        const entryPath = join(adapterPath, meta.entry || 'index.js');
        const url = pathToFileURL(entryPath).href;
        const entryUrl = hotReload ? `${url}?t=${Date.now()}` : url;
        
        const AdapterClass = (await import(entryUrl)).default;

        if (!AdapterClass || typeof AdapterClass !== 'function') {
            logErr(`⚠️ [适配器] ${entry.name} 未导出 default class`);
            continue;
        }

        const instance = new AdapterClass(meta);
        instance.name = meta.name;
        instance.platform = meta.platform || 'unknown';
        
        this.list.set(meta.name, instance);
        log(`✅ [适配器] 加载 ${instance.name} (${instance.platform})`);
      } catch (e) {
        logErr(`❌ [适配器] ${entry.name} 加载失败: ${e.stack || e.message}`);
      }
    }

    // 🌟 修复 2：清理已被物理删除的旧适配器（幽灵适配器）
    for (const existingName of this.list.keys()) {
        if (!validAdapterNames.has(existingName)) {
            log(`🗑️ [适配器] 移除已删除的适配器: ${existingName}`);
            this.list.delete(existingName);
        }
    }
  }

  /**
   * 挂载网络连接
   */
  mountNetwork(connections) {
    if (!connections || connections.length === 0) return;

    for (const conn of connections) {
      for (const adapter of this.list.values()) {
        if (conn.platform && adapter.platform !== conn.platform && adapter.platform !== 'all') {
          continue; 
        }

        if (typeof adapter.mount === 'function') {
          try {
            adapter.mount(conn);
            log(`🔗 [适配器] ${adapter.name} 已挂载到 ${conn.role || conn.name || '未知'} 连接`);
          } catch (e) {
            logErr(`❌ [适配器] ${adapter.name} 挂载失败: ${e.message}`);
          }
        }
      }
    }
  }

  getByPlatform(platform) {
    for (const adapter of this.list.values()) {
      if (adapter.platform === platform) return adapter;
    }
    return null;
  }

  /**
   * 统一消息解析入口
   */
  parseMessage(parsed) {
    for (const adapter of this.list.values()) {
      // 🌟 修复 3：为每个适配器单独 try-catch，防止一个适配器崩溃影响其他适配器
      try {
        if (typeof adapter.match === 'function' && adapter.match(parsed)) {
          
          const result = adapter.toStandard(parsed);
          
          if (!result) return null; 

          // 🌟 修复 4：安全触发事件，防止 emitEvent 内的异常阻断主消息流
          if (result.type === 'notice' || result.type === 'request') {
            if (typeof adapter.emitEvent === 'function') {
              try {
                // 如果 emitEvent 是异步的，加上 Promise.catch 防漏网之鱼
                const p = adapter.emitEvent(result.event, result);
                if (p && typeof p.catch === 'function') {
                    p.catch(err => logErr(`❌ [事件分发] ${adapter.name} 执行异常: ${err.stack || err.message}`));
                }
              } catch (err) {
                logErr(`❌ [事件分发] ${adapter.name} 同步执行异常: ${err.stack || err.message}`);
              }
            }
            return null; 
          }
          
          return result;
        }
      } catch (e) {
        logErr(`❌ [适配器] ${adapter.name} 解析数据时发生崩溃:\n${e.stack || e.message}`);
        // 继续尝试下一个适配器，不直接 return
      }
    }
    return null;
  }
}