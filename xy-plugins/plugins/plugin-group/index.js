import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class PluginGroup {
    constructor() {
        this.name = 'plugin-group';
        this.loadedPlugins = [];
        this._ready = false;
        
        this._loadConfig();
        this._loadSubPlugins();
    }

    _loadConfig() {
        const configPath = path.join(__dirname, 'config.yaml');
        if (!fs.existsSync(configPath)) return;
        try {
            const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
            this.globalConfig = config.global || {};
        } catch (e) {
            this.globalConfig = {};
        }
    }
    
    // 🌟 修复 1：app.js 传进来的是剥离过前缀的 pureText（字符串）
    match(data) {
        if (!this._ready || this.loadedPlugins.length === 0) return false;
        
        const pureText = typeof data === 'string' ? data.trim() : '';
        if (!pureText) return false;

        for (const plugin of this.loadedPlugins) {
            try {
                if (plugin.match && plugin.match(pureText)) {
                    return true;
                }
            } catch (e) {
                console.error(`[PluginGroup] 子插件 ${plugin.pluginConfig?.name} match 异常:`, e.message);
            }
        }
        return false;
    }

    async _loadSubPlugins() {
        console.log(`🚀 [调试] 开始加载子插件...`);

        const configPath = path.join(__dirname, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            console.log('❌ [调试] 找不到 config.yaml');
            return;
        }

        let config;
        try {
            config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error('❌ [调试] config.yaml 解析失败:', e.message);
            return;
        }

        const global = config.global || {};
        const plugins = config.plugins || [];

        if (plugins.length === 0) {
            console.log('⚠️ [调试] config.yaml 中 plugins 为空');
            return;
        }

        for (const item of plugins) {
            const pluginConfig = {
                name: item.name,
                enabled: item.enabled ?? global.enabled ?? true,
                path: item.path,
                entry: item.entry || 'index.js',
            };

            if (!pluginConfig.enabled) continue;

            try {
                const fullPath = path.join(__dirname, pluginConfig.path, pluginConfig.entry);

                if (!fs.existsSync(fullPath)) {
                    console.log(`❌ [失败] ${pluginConfig.name} 找不到文件: ${fullPath}`);
                    continue;
                }

                // 🌟 修复 2：使用 pathToFileURL 彻底解决 Windows/Linux 下 file:// 路径兼容问题
                const mod = await import(pathToFileURL(fullPath).href);
                const PluginExport = mod.default;

                let instance;
                if (typeof PluginExport === 'function') {
                    instance = new PluginExport(pluginConfig);
                } else if (typeof PluginExport === 'object' && PluginExport !== null) {
                    instance = PluginExport;
                } else {
                    continue;
                }

                instance.pluginConfig = pluginConfig;
                this.loadedPlugins.push(instance);
                console.log(`✅ [成功] ${pluginConfig.name}`);

            } catch (err) {
                console.error(`❌ [失败] ${pluginConfig.name}:`, err.message);
            }
        }

        this._ready = true;
        console.log(`🎉 共加载 ${this.loadedPlugins.length} 个子插件`);
    }

    // 🌟 修复 3：app.js 传进来的 data 是完整的 pluginMsg 对象
    async handle(data, context) {
        if (!this._ready || this.loadedPlugins.length === 0) return null;

        // 从对象里拿出剥离好的 pureText 用于匹配
        const pureText = data.pureText || data.content || '';
        if (!pureText) return null;

        for (const plugin of this.loadedPlugins) {
            // 用纯文本进行匹配
            if (plugin.match && !plugin.match(pureText)) continue;

            try {
                // 把完整对象传给子插件
                const result = await plugin.handle(data, context);
            
                // 🌟 修复 4：原样透传子插件的返回值，不再无脑截取 message
                // 这样无论是 { file: ... } 还是 { content: ... } 都能被 app.js 识别
                if (result) {
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