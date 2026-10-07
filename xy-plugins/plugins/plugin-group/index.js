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
        this._readyPromise = null;
        
        this._loadConfig();
        this._readyPromise = this._loadSubPlugins();
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

    /**
     * 【核心适配器】无论传入什么，都安全提取出纯文本
     * 兼容：字符串、std 对象、null、undefined、数字、数组
     */
    _extractText(data) {
        if (data === null || data === undefined) return '';
        if (typeof data === 'string') return data.trim();
        if (typeof data === 'number') return String(data);
        if (typeof data === 'object') {
            // 依次尝试常见的字段名：content / text / message / raw_message
            const raw = data.content ?? data.text ?? data.message ?? data.raw_message ?? '';
            return typeof raw === 'string' ? raw.trim() : String(raw).trim();
        }
        return '';
    }

    /**
     * 【统一入口】返回是否命中任何子插件
     */
    match(data) {
        if (!this._ready || this.loadedPlugins.length === 0) {
            return false;
        }

        const text = this._extractText(data);
        if (!text) return false; // 空文本直接不吃

        for (const plugin of this.loadedPlugins) {
            try {
                if (plugin.match && plugin.match(text)) {
                    return true;
                }
            } catch (e) {
                console.error(`[PluginGroup] 插件 ${plugin.pluginConfig?.name} 的 match 执行异常:`, e.message);
            }
        }

        return false; // 没有任何插件匹配，返回 false，不吞指令
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

    /**
     * 【统一处理入口】
     * 1. 提取文本，用于匹配子插件
     * 2. 匹配成功后，把完整数据传给子插件去处理
     * 3. 没有插件匹配就返回 null，不乱吃指令
     */
    async handle(data, context) {
        // 等待异步加载完成（防止竞态）
        if (this._readyPromise) await this._readyPromise;

        if (!this._ready || this.loadedPlugins.length === 0) {
            console.log('[PluginGroup] 子插件尚未加载完成，跳过处理');
            return null;
        }

        const text = this._extractText(data);
        if (!text) return null;

        for (const plugin of this.loadedPlugins) {
            const pluginName = plugin.pluginConfig?.name || '未知插件';

            // 先匹配，匹配不上直接跳过
            let matched = false;
            try {
                matched = plugin.match ? plugin.match(text) : false;
            } catch (e) {
                console.error(`[PluginGroup] 插件 ${pluginName} 的 match 执行异常:`, e.message);
                continue;
            }

            console.log(`[PluginGroup] 检查插件: ${pluginName} → ${matched}`);
            if (!matched) continue;

            // 匹配上了，把完整的原始数据交给子插件处理
            try {
                const result = await plugin.handle(data, context);

                // 处理返回格式
                if (result && typeof result === 'object' && result.message) {
                    return result.message;
                }
                if (typeof result === 'string') {
                    return result;
                }
            } catch (err) {
                console.error(`[PluginGroup] 子插件 ${pluginName} 执行出错:`, err.message);
            }
        }

        return null; // 没有任何插件能处理，不吞指令
    }
}

export default new PluginGroup();