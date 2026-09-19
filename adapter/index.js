// adapter/index.js
import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

export class AdapterRegistry {
  constructor() {
    this.adapters = new Map(); // name -> adapter实例
    this.eventHandler = null;
  }

  // 注入事件处理器
  setEventHandler(handler) {
    this.eventHandler = handler;
  }

  // 扫描 adapters 目录，动态加载所有适配器
  async scanAndLoad(adaptersDir) {
    if (!existsSync(adaptersDir)) {
      console.warn(`⚠ 适配器目录不存在: ${adaptersDir}`);
      return;
    }

    const dirs = readdirSync(adaptersDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      const adapterPath = join(adaptersDir, dir.name);
      const configPath = join(adapterPath, 'adapter.json');

      if (!existsSync(configPath)) {
        console.warn(`⚠ [${dir.name}] 缺少 adapter.json，跳过`);
        continue;
      }

      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));

        if (!config.enable) {
          console.log(`⏭ [${dir.name}] 未启用，跳过`);
          continue;
        }

        const entryPath = join(adapterPath, config.entry || 'index.js');
        const AdapterClass = (await import(entryPath)).default;

        if (!AdapterClass) {
          console.warn(`⚠ [${dir.name}] 入口文件未导出默认类，跳过`);
          continue;
        }

        const adapter = new AdapterClass(config);
        adapter.name = config.name || dir.name;
        adapter.platform = config.platform || 'unknown';

        // 注入事件处理器
        if (this.eventHandler) {
          adapter.setEventHandler(this.eventHandler);
        }

        this.adapters.set(adapter.name, adapter);
        console.log(`✅ [注册] ${adapter.name} (${adapter.platform})`);
      } catch (err) {
        console.error(`❌ [${dir.name}] 加载失败:`, err.message);
      }
    }
  }

  // 启动所有已注册的适配器
  async startAll() {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.start();
        console.log(`🚀 [启动] ${name} 已就绪`);
      } catch (err) {
        console.error(`❌ [${name}] 启动失败:`, err.message);
      }
    }
  }

  // 根据平台获取适配器
  get(platform) {
    for (const adapter of this.adapters.values()) {
      if (adapter.platform === platform) return adapter;
    }
    return null;
  }

  get count() {
    return this.adapters.size;
  }
}
