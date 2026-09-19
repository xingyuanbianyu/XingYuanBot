// xy-bot/plugin-loader.js
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';

export class PluginLoader {
    constructor(rootDir, adapter) {          // 👈 新增 adapter 参数
        this.root = rootDir;
        this.adapter = adapter;              // 👈 存起来，注册事件用
        this.plugins = new Map();
    }

    async load(platform = 'qq') {
        const platKey = platform.toLowerCase();

        const commonDir = join(this.root, 'plugins');
        if (await isDir(commonDir)) {
            for (const name of await getDirs(commonDir)) await this.loadOne(commonDir, name, '通用');
        }

        const platDir = join(this.root, platKey);
        if (await isDir(platDir)) {
            for (const name of await getDirs(platDir)) await this.loadOne(platDir, name, platform.toUpperCase());
        }

        return [...this.plugins.values()];
    }

    async loadOne(groupDir, name, scope) {
        const dir = join(groupDir, name);
        if (!(await isDir(dir))) return;

        const rulePath = join(dir, 'rule.json');
        if (!(await isFile(rulePath))) {
            print(`  ⚠️ 跳过 [${scope}] ${name}：缺少 rule.json`);
            return;
        }

        try {
            const raw = await readFile(rulePath, 'utf-8');
            const rule = JSON.parse(raw);
            const entryFile = rule.entry || 'index.js';
            const entryPath = join(dir, entryFile);

            if (!(await isFile(entryPath))) {
                print(`  ⚠️ 跳过 [${scope}] ${name}：入口文件 ${entryFile} 不存在`);
                return;
            }

            const entryUrl = pathToFileURL(entryPath).href;
            const pluginModule = await import(entryUrl);
            const handler = pluginModule.default;

            this.plugins.set(name, { name, scope, dir, rule, handler });
            print(`  📦 [${scope}] 加载插件: ${name} (入口: ${entryFile})`);

            // 新增：事件型插件注册到适配器
            if (Array.isArray(handler?.events) && typeof handler?.onEvent === 'function') {
                for (const ev of handler.events) {
                    if (this.adapter && typeof this.adapter.onEvent === 'function') {
                        this.adapter.onEvent(ev, payload => {
                            payload.event = ev;
                            handler.onEvent(payload, this.adapter.conn, this.adapter);
                        });
                        print(`  ✅ [${scope}] ${name} 已订阅事件: ${ev}`);
                    } else {
                        print(`  ⚠️ [${scope}] ${name} 订阅 ${ev} 失败: 适配器未注入或不支持 onEvent`);
                    }
                }
            }
        } catch (e) {
            print(`  ⚠️ 跳过 [${scope}] ${name}：加载失败 (${e.message})`);
        }
    }
}

async function getDirs(p) {
    try {
        const list = await readdir(p, { withFileTypes: true });
        return list.filter(d => d.isDirectory()).map(d => d.name);
    } catch { return []; }
}
async function isDir(p) {
    try { return (await stat(p)).isDirectory(); } catch { return false; }
}
async function isFile(p) {
    try { return (await stat(p)).isFile(); } catch { return false; }
}
