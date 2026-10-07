import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url'; // 解决 Windows 下动态 import 的路径问题
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
        const entryPath = join(adapterPath, meta.entry || 'index.js');
        
        // 转换为 file:// 协议路径
        const entryUrl = pathToFileURL(entryPath).href;
        const AdapterClass = (await import(entryUrl)).default;

        if (!AdapterClass) continue;

        const instance = new AdapterClass(meta);
        instance.name = meta.name;
        instance.platform = meta.platform || 'unknown';
        this.list.set(meta.name, instance);
        
        console.log(`✅ [适配器] 加载 ${instance.name} (${instance.platform})`);
      } catch (e) {
        console.error(`❌ [适配器] ${entry.name} 加载失败:`, e.message);
      }
    }
  }

  mountNetwork(connections) {
    for (const conn of connections) {
      for (const adapter of this.list.values()) {
        if (typeof adapter.mount === 'function') {
          adapter.mount(conn);
          console.log(`🔗 [适配器] ${adapter.name} 已挂载到 ${conn.role} 连接`);
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
}
