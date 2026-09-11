import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'node:path';
import { pathToFileURL } from 'url';

const PLUGINS_DIR = './xy-plugins';

let _loaded = false;
let _pluginsCache = null;

export async function loadPlugins() {
  if (_pluginsCache) return _pluginsCache;
  if (_loaded) return plugins;
  const plugins = [];
  if (!existsSync(PLUGINS_DIR)) return plugins;

  const dirs = readdirSync(PLUGINS_DIR).filter(n => {
    const p = join(PLUGINS_DIR, n);
    return statSync(p).isDirectory();
  });

  for (const dirName of dirs) {
    const pluginPath = join(PLUGINS_DIR, dirName);
    const rulePath = join(pluginPath, 'rule.json');

    if (!existsSync(rulePath)) {
      console.log(`⚠️ 插件 [${dirName}] 缺少 rule.json，跳过`);
      continue;
    }

    try {
      const rule = JSON.parse(readFileSync(rulePath, 'utf-8'));
      
      // 如果没有配置 entry，默认使用 index.js
      const entryFile = rule.entry || 'index.js';
      const entryPath = join(pluginPath, entryFile);

      if (!existsSync(entryPath)) {
        console.log(`⚠️ 插件 [${dirName}] 入口文件 ${entryFile} 不存在，跳过`);
        continue;
      }

      // 转换为 file:// URL 避免 Windows 路径报错
      const moduleURL = pathToFileURL(entryPath).href;
      const cacheBustURL = moduleURL + '?t=' + Date.now();
      const mod = await import(cacheBustURL);

      plugins.push({
        name: dirName,
        rule,
        handler: mod.default
      });

      console.log(`✅ 插件 [${dirName}] 加载成功`);
    } catch (e) {
      console.error(`❌ 插件 [${dirName}] 加载失败:`, e.message);
    }
  }

  console.log(`🎉 成功加载 ${plugins.length} 个插件\n`);
  _loaded = true;
  _pluginsCache = plugins;
  return plugins;
}
