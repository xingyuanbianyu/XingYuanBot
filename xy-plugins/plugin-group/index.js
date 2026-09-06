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
    
    match(data) {
        // 子插件还没加载完，不拦截
        if (!this._ready || this.loadedPlugins.length === 0) {
            return false;
        }

        // 只有当至少一个子插件匹配时，才返回 true
        for (const plugin of this.loadedPlugins) {
            if (plugin.match && plugin.match(data)) {
                return true;
            }
        }

        return false;
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
                const PluginExport = mod.default;

                let instance;

                if (typeof PluginExport === 'function') {
                    instance = new PluginExport(pluginConfig);
                } else if (typeof PluginExport === 'object' && PluginExport !== null) {
                    instance = PluginExport;
                } else {
                    console.log(`❌ [失败] ${pluginConfig.name} 导出的既不是类也不是对象`);
                    continue;
                }

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

    async handle(data, context) {
        // 确保子插件已加载完成
        if (!this._ready || this.loadedPlugins.length === 0) {
            console.log('[PluginGroup] 子插件尚未加载完成，跳过处理');
            return null;
        }

        for (const plugin of this.loadedPlugins) {
            // 如果子插件有自己的 match 方法，先检查
            if (plugin.match && !plugin.match(data)) continue;

            try {
                const result = await plugin.handle(data, context);
            
                // 如果子插件返回的是 { type: 'reply', message: '...' }
                if (result && typeof result === 'object') {
                    if (result.message) {
                        return result.message; // 只返回字符串
                    }
                }
            
                // 如果子插件直接返回字符串，就原样返回
                if (typeof result === 'string') {
                    return result;
                }
            } catch (err) {
                console.error(`[PluginGroup] 子插件 ${plugin.pluginConfig?.name} 执行出错:`, err.message);
            }
        }
        
    return null;
    }

}
export default new PluginGroup();
