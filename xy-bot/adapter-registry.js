import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

// 🌟 统一日志
const log = (msg) => (globalThis.print || console.log)(msg);
const logErr = (msg) => (globalThis.print || console.error)(msg);

export class AdapterRegistry {
  constructor() {
    this.list = new Map();
  }

  async scan(adaptersDir) {
    if (!existsSync(adaptersDir)) return;

    for (const entry of readdirSync(adaptersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('_') || entry.name.endsWith('.disabled')) continue;

      const adapterPath = join(adaptersDir, entry.name);
      const cfgPath = join(adapterPath, 'adapter.json');

      if (!existsSync(cfgPath)) continue;

      try {
        const meta = JSON.parse(readFileSync(cfgPath, 'utf8'));
        
        // 检查名称冲突
        if (this.list.has(meta.name)) {
            logErr(`⚠️ [适配器] 发现同名适配器 [${meta.name}]，将被忽略: ${entry.name}`);
            continue;
        }

        const entryPath = join(adapterPath, meta.entry || 'index.js');
        
        // 破除 ESM 缓存 (如果支持热重载适配器)
        const entryUrl = pathToFileURL(entryPath).href + `?t=${Date.now()}`;
        const AdapterClass = (await import(entryUrl)).default;

        if (!AdapterClass) {
            logErr(`⚠️ [适配器] ${entry.name} 未导出 default 类`);
            continue;
        }

        const instance = new AdapterClass(meta);
        instance.name = meta.name;
        instance.platform = meta.platform || 'unknown';
        this.list.set(meta.name, instance);
        
        log(`✅ [适配器] 加载 ${instance.name} (${instance.platform})`);
      } catch (e) {
        logErr(`❌ [适配器] ${entry.name} 加载失败: ${e.message}`);
      }
    }
  }

  mountNetwork(connections) {
    if (!connections || connections.length === 0) return;

    for (const conn of connections) {
      for (const adapter of this.list.values()) {
        if (typeof adapter.mount === 'function') {
          try {
            adapter.mount(conn);
            log(`🔗 [适配器] ${adapter.name} 已挂载到 ${conn.role} 连接`);
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

  // ============================================================
  // 🌟 核心：统一消息解析入口，严格分离“消息”与“事件”
  // ============================================================
  /**
   * 根据原始数据寻找匹配的适配器，并转换为标准消息/事件
   * @param {Object} parsed 原始 JSON 数据
   * @returns {Object|null} 标准消息对象，无适配器匹配或发生事件则返回 null
   */
  parseMessage(parsed) {
    for (const adapter of this.list.values()) {
      try {
        if (typeof adapter.match === 'function' && adapter.match(parsed)) {
          const result = adapter.toStandard(parsed);
          
          if (!result) return null; // 适配器解析失败或忽略此包

          // 🌟 核心修复：拦截事件，主动触发 emitEvent！
          if (result.type === 'notice' || result.type === 'request') {
              if (typeof adapter.emitEvent === 'function') {
                  // 触发事件，将消息分发给监听该事件的插件（如防撤回、入群验证）
                  adapter.emitEvent(result.event, result);
              }
              // 返回 null，表示事件已被拦截，不需要交给 main.js 的消息主流程处理
              return null; 
          }
          
          // 如果是普通消息，直接返回给 main.js 继续走后续流程
          return result;
        }
      } catch (e) {
        logErr(`❌ [适配器] ${adapter.name} 解析消息失败: ${e.message}`);
      }
    }
    return null;
  }
}