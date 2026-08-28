import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

let loadedPlugins = [];
let groupConfig = null;

// ============ 初始化：读取 config.yaml 并加载启用的子插件 ============
async function init() {
  const configPath = join(__dirname, 'config.yaml');
  if (!existsSync(configPath)) {
    console.log('⚠ config.yaml 不存在，跳过加载');
    return;
  }

  const yamlStr = readFileSync(configPath, 'utf-8');
  groupConfig = parse(yamlStr);  // ← 这里用 parse，不是 load

  for (const cfg of groupConfig.plugins) {
    if (!cfg.enabled) {
      console.log(`⏭ 插件 [${cfg.name}] 未启用，跳过`);
      continue;
    }

    const entryPath = join(__dirname, cfg.entry);
    if (!existsSync(entryPath)) {
      console.log(`⚠ 插件 [${cfg.name}] 入口文件不存在: ${cfg.entry}`);
      continue;
    }

    try {
      const moduleURL = new URL(`file://${entryPath}`).href;
      const mod = await import(moduleURL);
      loadedPlugins.push({
        name: cfg.name,
        type: cfg.type,       // 'command' | 'event'
        handler: mod.default || mod,
      });
      console.log(`✅ 插件 [${cfg.name}] 加载成功`);
    } catch (e) {
      console.error(`❌ 插件 [${cfg.name}] 加载失败: ${e.message}`);
    }
  }

  console.log(`📦 成功加载 ${loadedPlugins.length} 个子插件`);
}

// ============ 超时包装器 ============
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时 ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ============ 消息处理入口 ============
export default async function handle(msg) {
  // 懒加载：首次调用时初始化
  if (loadedPlugins.length === 0 && !groupConfig) {
    await init();
  }

  // 提取消息文本
  let text = '';
  if (Array.isArray(msg.message)) {
    for (const seg of msg.message) {
      if (seg.type === 'text') {
        text += seg.data.text.trim();
      }
    }
  } else if (typeof msg.message === 'string') {
    text = msg.message;
  }

  // 遍历已启用的子插件
  for (const plugin of loadedPlugins) {
    const handler = plugin.handler;

    // --- 指令类型：需要匹配 ---
    if (plugin.type === 'command') {
      if (typeof handler.match !== 'function' || !handler.match(text)) {
        continue; // 不匹配 → 跳过
      }
    }

    try {
      const reply = await withTimeout(
        handler.handle({ text, msg }),
        groupConfig.timeout
      );

      if (reply) {
        console.log(`↩ [${plugin.name}] 已回复，终止传递`);
        return reply; // ✅ 有回复 → 终止循环，不再传给后续插件
      }
    } catch (e) {
      console.log(`⏭ [${plugin.name}] ${e.message}，跳过`);
    }
  }

  // 所有插件都没有回复
  return null;
}

// 启动时预加载
init();
