import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import YAML from 'yaml';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');

class PluginGroup {
    constructor() {
        this.name = 'plugin-group';
        this.loadedPlugins = [];
        this._ready = false;
        this._isReloading = false;
        
        this._loadConfig();
        this._initWatcher(); // 🌟 修复 1：监听配置文件自身变化
        this._loadSubPlugins();
    }

    _loadConfig() {
        if (!fs.existsSync(CONFIG_PATH)) {
            this.config = { plugins: [] };
            this.globalConfig = {};
            return;
        }
        try {
            this.config = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
            this.globalConfig = this.config.global || {};
            if (!Array.isArray(this.config.plugins)) this.config.plugins = [];
        } catch (e) {
            this.globalConfig = {};
            this.config = { plugins: [] };
        }
    }

    _saveConfig() {
        try {
            fs.writeFileSync(CONFIG_PATH, YAML.stringify(this.config), 'utf8');
            return true;
        } catch (e) {
            console.error(`[PluginGroup] 保存配置失败:`, e.message);
            return false;
        }
    }

    // 🌟 修复 2：自动重载配置，解决修改路径不生效的问题
    _initWatcher() {
        if (!fs.existsSync(CONFIG_PATH)) return;
        try {
            fs.watch(CONFIG_PATH, (event) => {
                if (event === 'change' && !this._isReloading) {
                    this._isReloading = true;
                    setTimeout(async () => {
                        console.log(`[PluginGroup] 👀 检测到 config.yaml 修改，正在重新加载子插件...`);
                        this._loadConfig();
                        await this._loadSubPlugins();
                        this._isReloading = false;
                    }, 200); // 防抖
                }
            });
        } catch (e) {}
    }

    _getGroupFromPath(p) {
        if (!p) return '根目录';
        let cleanPath = p.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (!cleanPath || cleanPath === '.') {
            return '根目录';
        }
        return cleanPath.split('/')[0];
    }

    _replaceGroupInPath(p, newGroup) {
        if (!p) return `./${newGroup}`;
        let cleanPath = p.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (!cleanPath || cleanPath === '.') {
            return `./${newGroup}`;
        }
        const parts = cleanPath.split('/');
        parts[0] = newGroup; 
        return './' + parts.join('/');
    }

    async _checkAdmin(msg) {
        // 🌟 修复 3：严格判断群聊环境并传递 _ws
        if (!msg.isGroup) return false;
        
        let hasPermission = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { 
                group_id: Number(msg.chatId), 
                user_id: Number(msg.senderQQ) 
            }, 3000, msg._ws); // 传入 msg._ws

            if (res?.data && ['owner', 'admin'].includes(res.data.role)) hasPermission = true;
        } catch (e) {}
        
        if (!hasPermission && typeof getRole === 'function') {
            if (['master', 'owner', 'admin'].includes(getRole(msg.senderQQ))) hasPermission = true;
        }
        return hasPermission;
    }
    
    match(data) {
        const pureText = typeof data === 'string' ? data.trim() : (data.pureText || data.content || '').trim();
        if (!pureText) return false;

        // 匹配管理指令
        if (/^(创建分组|删除分组|查看分组|移动子插件)/.test(pureText)) return true;

        // 匹配子插件
        for (const plugin of this.loadedPlugins) {
            try {
                if (plugin.match && plugin.match(pureText)) return true;
            } catch (e) {}
        }
        return false;
    }

    async _loadSubPlugins() {
        const global = this.config.global || {};
        const plugins = this.config.plugins || [];
        this.loadedPlugins = []; // 🌟 每次重载前清空旧实例

        if (plugins.length === 0) {
            this._ready = true;
            return;
        }

        for (const item of plugins) {
            const pluginConfig = {
                name: item.name || item.entry,
                enabled: item.enabled ?? global.enabled ?? true,
                path: item.path,
                entry: item.entry || 'index.js',
            };

            if (!pluginConfig.enabled) continue;

            try {
                // 🌟 核心修复 4：加入时间戳破除 ESM 缓存，实现真正的动态热重载
                const fullPath = path.resolve(__dirname, pluginConfig.path, pluginConfig.entry);
                const fileUrl = pathToFileURL(fullPath).href + `?t=${Date.now()}`;
                
                if (!fs.existsSync(fullPath)) {
                    console.log(`❌ [失败] ${pluginConfig.name} 找不到文件: ${fullPath}`);
                    continue;
                }

                const mod = await import(fileUrl);
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
                console.log(`✅ [成功] ${pluginConfig.entry} (组: ${this._getGroupFromPath(pluginConfig.path)})`);

            } catch (err) {
                console.error(`❌ [失败] ${pluginConfig.name}:`, err.message);
            }
        }

        this._ready = true;
        console.log(`🎉 共加载 ${this.loadedPlugins.length} 个子插件`);
    }

    async handle(data, context) {
        const pureText = (data.pureText || data.content || '').trim();
        if (!pureText) return null;

        // ==========================================
        // 🌟 管理分组指令
        // ==========================================
        if (/^(创建分组|删除分组|查看分组|移动子插件)/.test(pureText)) {
            const hasPerm = await this._checkAdmin(data);
            if (!hasPerm) return '❌ 权限不足：仅群主、管理员或主人可操作。';

            // 1. 查看分组
            if (pureText.startsWith('查看分组')) {
                const groups = {};
                for (const p of this.config.plugins) {
                    const gName = this._getGroupFromPath(p.path);
                    if (!groups[gName]) groups[gName] = [];
                    groups[gName].push(p.entry || 'index.js');
                }

                let reply = `📊 **当前插件分组状态**\n\n`;
                for (const [gName, plist] of Object.entries(groups)) {
                    reply += `📁 【${gName}】 (${plist.length}个)\n`;
                    plist.forEach(entry => { reply += `   - ${entry}\n`; });
                    reply += `\n`;
                }
                return reply.trim();
            }

            // 2. 创建分组
            if (pureText.startsWith('创建分组')) {
                const groupName = pureText.replace('创建分组', '').trim();
                if (!groupName) return '⚠️ 用法：创建分组 [名字]';
                return `✅ 分组【${groupName}】创建成功！\n💡 提示：在本地目录中新建文件夹【${groupName}】，并将插件移入即可。`;
            }

            // 3. 删除分组
            if (pureText.startsWith('删除分组')) {
                const groupName = pureText.replace('删除分组', '').trim();
                if (!groupName) return '⚠️ 用法：删除分组 [名字]';

                let movedCount = 0;
                for (const p of this.config.plugins) {
                    const currentGroup = this._getGroupFromPath(p.path);
                    if (currentGroup === groupName) {
                        let cleanPath = p.path.replace(/^\.\//, '').replace(/^\/+/, '');
                        if (cleanPath.includes('/')) {
                            p.path = './' + cleanPath.split('/').slice(1).join('/');
                        } else {
                            p.path = '.'; 
                        }
                        movedCount++;
                    }
                }

                if (movedCount > 0) {
                    this._saveConfig();
                    // 这里不需要手动重载，_initWatcher 会自动检测到文件变化并重载
                    return `✅ 已删除分组【${groupName}】，里面的 ${movedCount} 个插件路径已重置为根目录。\n🔄 正在自动重载子插件...`;
                } else {
                    return `⚠️ 找不到分组：${groupName}`;
                }
            }

            // 4. 移动子插件
            if (pureText.startsWith('移动子插件')) {
                const args = pureText.replace('移动子插件', '').trim().split(/\s+/);
                if (args.length < 2) return '⚠️ 用法：移动子插件 [插件名/入口文件/旧分组] [新分组]';
                
                const target = args[0];
                const newGroup = args[1];
                
                let movedCount = 0;
                for (const p of this.config.plugins) {
                    const currentGroup = this._getGroupFromPath(p.path);
                    if (p.name === target || p.entry === target || currentGroup === target) {
                        p.path = this._replaceGroupInPath(p.path, newGroup);
                        movedCount++;
                    }
                }

                if (movedCount > 0) {
                    this._saveConfig();
                    return `✅ 成功将 ${movedCount} 个插件指向了【${newGroup}】路径！\n🔄 正在自动重载子插件...\n⚠️ 请确保服务器物理目录中已存在该文件夹。`;
                } else {
                    return `⚠️ 找不到插件或分组：${target}`;
                }
            }
        }

        // ==========================================
        // 向下分发给子插件
        // ==========================================
        if (!this._ready || this.loadedPlugins.length === 0) return null;

        for (const plugin of this.loadedPlugins) {
            if (plugin.match && !plugin.match(pureText)) continue;

            try {
                const result = await plugin.handle(data, context);
                if (result) return result; 
            } catch (err) {
                // 🌟 修复 5：子插件报错不应该中断整个流程，应该打印错误并继续给下一个子插件处理机会
                console.error(`[PluginGroup] 子插件 [${plugin.pluginConfig?.name}] 执行出错:`, err.message);
                // return `❌ 内部模块发生错误，请联系管理员。`; // 你可以选择是否向用户抛出错误
            }
        }
        return null;
    }
}

export default new PluginGroup();