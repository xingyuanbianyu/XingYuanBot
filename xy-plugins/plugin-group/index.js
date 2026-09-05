import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class PluginGroup {
    constructor() {
        this.name = 'plugin-group';
        this.prefixes = [];
        this.keywords = [];
        this.loadedPlugins = [];
        this._ready = false;
        
        this._loadConfig();
        this._loadSubPlugins();
    }

    _loadConfig() {
        const configPath = path.join(__dirname, 'config.yaml');
        if (!fs.existsSync(configPath)) return;
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        const global = config.global || {};
        
        if (global.prefixes) {
            this.prefixes = global.prefixes;
        } else if (global.prefix) {
            this.prefixes = [global.prefix];
        } else {
            this.prefixes = ['#'];
        }
        
        this.keywords = global.keywords || [];
    }
    
    // ✅ 改为接收 data 对象，从原始消息取文本
    match(data) {
        if (!data) return false;

        // 从原始消息中取文本（不会被主框架剥离前缀）
        const rawText = data.msg?.raw_message || data.msg?.message || '';
        if (!rawText) return false;

        // 1. 检测前缀（必须匹配至少一个）
        const hasPrefix = this.prefixes.some(p => rawText.startsWith(p));
        if (!hasPrefix) return false;

        // 2. 检测关键词（如果配了，必须包含至少一个）
        if (this.keywords && this.keywords.length > 0) {
            const hasKeyword = this.keywords.some(k => rawText.includes(k));
            if (!hasKeyword) return false;
        }

        return true;
    }

    async _loadSubPlugins() {
        console.log(`🚀 [调试] 开始加载子插件...`);

        const configPath = path.join(__dirname, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            console.log('❌ [调试] 找不到 config.yaml，路径:', configPath);
            return;
        }

        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        const global = config.global || {};
        const plugins = config.plugins || [];

        if (plugins.length === 0) {
            console.log('⚠️ [调试] config.yaml 中 plugins 为空');
            return;
        }
        console.log(`📦 发现 ${plugins.length} 个插件配置`);

        for (const item of plugins) {
            const pluginConfig = {
                name: item.name,
                enabled: item.enabled ?? global.enabled ?? true,
                path: item.path,
                entry: item.entry || 'index.js',
                type: item.type ?? global.type ?? 'command',
                timeout: item.timeout ?? global.timeout ?? 1000,
                // ✅ 子插件也拿到自己的前缀和关键词配置
                prefixes: item.prefixes || this.prefixes,
                keywords: item.keywords || this.keywords,
            };

            if (!pluginConfig.enabled) {
                console.log(`⏭️  [跳过] ${pluginConfig.name}（未启用）`);
                continue;
            }

            try {
                const fullPath = path.join(__dirname, pluginConfig.path, pluginConfig.entry);

                if (!fs.existsSync(fullPath)) {
                    console.log(`❌ [失败] ${pluginConfig.name} 找不到文件: ${fullPath}`);
                    continue;
                }

                const mod = await import(`file://${fullPath}`);
                const PluginClass = mod.default;

                if (typeof PluginClass !== 'function') {
                    console.log(`❌ [失败] ${pluginConfig.name} 导出的不是类`);
                    continue;
                }

                const instance = new PluginClass(pluginConfig);
                instance.pluginConfig = pluginConfig;
                this.loadedPlugins.push(instance);

                console.log(`✅ [成功] ${pluginConfig.name}（类型: ${pluginConfig.type}, 超时: ${pluginConfig.timeout}ms）`);
            } catch (err) {
                console.error(`❌ [失败] ${pluginConfig.name}:`, err.message);
            }
        }

        this._ready = true;
        console.log(`🎉 共加载 ${this.loadedPlugins.length} 个子插件`);
    }

    async handle(data) {
        const postType = data?.msg?.post_type || data?.post_type;
        
        // ✅ 获取原始消息
        const rawText = data.msg?.raw_message || data.msg?.message || '';

        console.log(`📥 [plugin-group] 收到事件 postType=${postType}, 原始消息: ${rawText}, 已加载插件数=${this.loadedPlugins.length}`);

        if (!this._ready || this.loadedPlugins.length === 0) return null;

        const targetType = postType === 'message' ? 'command' : 'event';

        for (const plugin of this.loadedPlugins) {
            const pluginType = plugin.pluginConfig?.type || 'command';

            if (pluginType !== targetType) continue;

            // ✅ 在 handle 里也用原始消息做匹配（双重保险，不依赖主框架调 match）
            const config = plugin.pluginConfig || {};
            const prefixes = config.prefixes || this.prefixes;
            const keywords = config.keywords || this.keywords;

            // 前缀匹配
            const hasPrefix = prefixes.some(p => rawText.startsWith(p));
            if (!hasPrefix) continue;

            // 关键词匹配
            if (keywords && keywords.length > 0) {
                const hasKeyword = keywords.some(k => rawText.includes(k));
                if (!hasKeyword) continue;
            }

            console.log(`🔄 [plugin-group] 调用子插件: ${plugin.pluginConfig?.name}`);

            try {
                if (typeof plugin.handle === 'function') {
                    const result = await plugin.handle(data);
                    if (result !== undefined && result !== null) return result;
                }
            } catch (err) {
                console.error(`[plugin-group] 子插件 ${plugin.pluginConfig?.name} 报错:`, err.message);
            }
        }
        return null;
    }
}
   
export default new PluginGroup();