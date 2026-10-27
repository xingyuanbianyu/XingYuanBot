import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

// 🌟 引入数据库权限管理接口
import { setLocalPermission, removeLocalPermission, listUserPermissions } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../../../xy-config/config/config.yaml');

const verificationCodes = new Map();
const CODE_EXPIRE = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [qq, v] of verificationCodes.entries()) {
        if (now - v.time > CODE_EXPIRE) verificationCodes.delete(qq);
    }
}, 60 * 1000);

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    try { return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {}; } catch (e) { return null; }
}

function saveConfig(config) {
    try {
        const tmpPath = CONFIG_PATH + '.tmp';
        fs.writeFileSync(tmpPath, yaml.stringify(config), 'utf-8');
        fs.renameSync(tmpPath, CONFIG_PATH);
        if (typeof globalThis._configReload === 'function') globalThis._configReload();
    } catch (e) { console.error('[权限] 写入 config.yaml 失败:', e.message); }
}

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

function getMasterQQ(config) {
    const owners = config?.permissions?.owners || {};
    for (const [qq, val] of Object.entries(owners)) {
        if (val === true || val === 'true') return qq;
    }
    return null;
}

function ensurePermissions(config) {
    if (!config.permissions) config.permissions = {};
    if (!config.permissions.owners) config.permissions.owners = {};
    if (!config.permissions.owner_permission) config.permissions.owner_permission = {};
}

function parseArgs(args, targetQQFromAt = null) {
    let rest = args.slice(1);
    rest = rest.filter(a => !a.includes('@') && !a.includes('[CQ:at'));

    let botId = null;
    let targetQQ = targetQQFromAt;

    if (targetQQFromAt) {
        if (rest.length >= 1) botId = String(rest[0]);
    } else {
        if (rest.length === 1) {
            targetQQ = String(rest[0]); 
        } else if (rest.length >= 2) {
            botId = String(rest[0]);    
            targetQQ = String(rest[1]);
        }
    }
    return { targetQQ, botId };
}

export default {
    match(text) {
        if (typeof text !== 'string') return false;
        return /^(设置主人|设置大主人|设置小主人|删除主人|取消主人|权限状态|查询权限)(\s|$)/.test(text.trim());
    },

    async handle(msgObj) {
        const text = (msgObj.pureText || msgObj.content || msgObj.text || '').trim();
        const senderQQ = String(msgObj.senderQQ || msgObj.senderId || msgObj.user_id || '');
        if (!text || !senderQQ) return null;

        let targetQQFromAt = null;
        if (Array.isArray(msgObj.message)) {
            const atItem = msgObj.message.find(item => item?.type === 'at' && item.data?.qq !== 'all');
            if (atItem) targetQQFromAt = String(atItem.data.qq);
        }

        const args = text.split(/\s+/);
        let cmd = args[0];
        if (cmd === '查询权限') cmd = '权限状态';
        if (cmd === '取消主人') cmd = '删除主人';

        try {
            if (cmd === '设置主人') return await this.handleSetMaster(args, senderQQ);
            if (cmd === '设置大主人') return await this.handleSetBigOwner(args, senderQQ, targetQQFromAt);
            if (cmd === '设置小主人') return await this.handleSetOwner(args, senderQQ, targetQQFromAt);
            if (cmd === '删除主人') return await this.handleRemoveOwner(args, senderQQ, targetQQFromAt);
            if (cmd === '权限状态') return await this.handlePermission(args, senderQQ, targetQQFromAt);
        } catch (e) {
            console.error('[权限管理插件错误]', e);
            return '操作失败: ' + e.message;
        }
        return null;
    },

    // 1. 首次验证（不变）
    async handleSetMaster(args, senderQQ) {
        const config = loadConfig();
        if (!config) return '❌ 配置文件不存在';

        const masterQQ = getMasterQQ(config);
        if (masterQQ) {
            if (String(senderQQ) !== String(masterQQ)) return '❌ 已有大主人，请使用"设置大主人"或"设置小主人"指令';
            return '📌 你已是大主人，使用"设置大主人"或"设置小主人"添加管理员';
        }

        if (args.length === 1) {
            const code = generateCode();
            verificationCodes.set(String(senderQQ), { code, time: Date.now() });
            console.log(`\n📌 验证码 [${senderQQ}]: ${code}  (发送: 设置主人 ${senderQQ} ${code})\n`);
            return `✅ 验证码已生成，请在控制台查看，发送："设置主人 ${senderQQ} ******"（5分钟内有效）\n🎉 验证通过后将成为【全局大主人】`;
        } 
        
        if (args.length === 3) {
            const targetQQ = String(args[1]);
            const code = args[2].toUpperCase();
            if (targetQQ !== String(senderQQ)) return '❌ 安全限制：验证码只能用于将自己设置为大主人';

            const verify = verificationCodes.get(String(senderQQ));
            if (!verify) return '❌ 验证失败，请重新执行"设置主人"';
            if (Date.now() - verify.time > CODE_EXPIRE) {
                verificationCodes.delete(String(senderQQ));
                return '❌ 验证码已过期，请重新执行"设置主人"';
            }
            if (verify.code !== code) return '❌ 验证码错误';

            ensurePermissions(config);
            config.permissions.owners[targetQQ] = true;
            config.permissions.owner_permission[targetQQ] = 1;
            saveConfig(config);
            verificationCodes.delete(String(senderQQ));
            return '✅ 验证成功，你已成功成为【全局大主人】！';
        }
        return '📌 格式：\n  首次：设置主人\n  验证：设置主人 <你的QQ号> <验证码>';
    },

    // 2. 设置局部大主人 (改为写数据库)
    async handleSetBigOwner(args, senderQQ, targetQQFromAt) {
        const config = loadConfig();
        if (String(senderQQ) !== String(getMasterQQ(config))) return '❌ 只有全局大主人可以设置局部大主人';

        const { targetQQ, botId } = parseArgs(args, targetQQFromAt);
        if (!botId) return '❌ 必须提供 Bot 号\n格式：设置大主人 [Bot号] [目标QQ/at]';
        if (!targetQQ || !/^\d{5,12}$/.test(targetQQ)) return '❌ 目标 QQ 格式不正确';

        // 检查是否已经是全局身份
        const current = config.permissions?.owners?.[targetQQ];
        if (current === true) return `❌ ${targetQQ} 已经是全局大主人，无需设置局部`;
        if (current === false) return `❌ ${targetQQ} 已经是全局小主人，如需局部提升，请先删除全局身份`;

        // 🌟 写入 SQLite 数据库
        const res = setLocalPermission(targetQQ, botId, 'master');
        if (!res.success) return `❌ 设置失败: ${res.error}`;
        
        return `✅ 已成功将 ${targetQQ} 设置为 Bot [${botId}] 的【局部大主人】`;
    },

    // 3. 设置全局/局部小主人 (局部写数据库)
    async handleSetOwner(args, senderQQ, targetQQFromAt) {
        const config = loadConfig();
        if (String(senderQQ) !== String(getMasterQQ(config))) return '❌ 只有全局大主人可以设置小主人';

        const { targetQQ, botId } = parseArgs(args, targetQQFromAt);
        if (!targetQQ || !/^\d{5,12}$/.test(targetQQ)) return '❌ 目标 QQ 格式不正确';

        ensurePermissions(config);
        const current = config.permissions?.owners?.[targetQQ];
        if (current === true) return `❌ ${targetQQ} 已经是全局大主人，无法降级`;

        if (!botId) {
            // 设全局小主人 (写 YAML)
            config.permissions.owners[targetQQ] = false;
            config.permissions.owner_permission[targetQQ] = 0;
            saveConfig(config);
            return `✅ 已将 ${targetQQ} 设置为【全局小主人】\n（默认权限关闭，使用"权限状态 开 ${targetQQ}"开启）`;
        } else {
            // 设局部小主人 (写 SQLite)
            if (current === false) return `❌ ${targetQQ} 已经是全局小主人，请先删除全局身份`;
            
            const res = setLocalPermission(targetQQ, botId, 'owner');
            if (!res.success) return `❌ 设置失败: ${res.error}`;
            
            return `✅ 已成功将 ${targetQQ} 设置为 Bot [${botId}] 的【局部小主人】`;
        }
    },

    // 4. 删除全局/局部主人 (局部删数据库)
    async handleRemoveOwner(args, senderQQ, targetQQFromAt) {
        const config = loadConfig();
        if (String(senderQQ) !== String(getMasterQQ(config))) return '❌ 只有全局大主人可以删除主人';

        const { targetQQ, botId } = parseArgs(args, targetQQFromAt);
        if (!targetQQ) return '📌 格式：删除主人 [Bot号] [目标QQ/at]';
        if (targetQQ === String(getMasterQQ(config))) return '❌ 不能删除全局大主人的身份';

        if (!botId) {
            // 删除全局
            const owners = config.permissions?.owners || {};
            if (owners[targetQQ] === undefined) return `❌ ${targetQQ} 没有任何全局身份`;

            delete config.permissions.owners[targetQQ];
            if (config.permissions.owner_permission) delete config.permissions.owner_permission[targetQQ];
            saveConfig(config);
            return `✅ 已完全删除 ${targetQQ} 的所有全局身份`;
        } else {
            // 删除局部 (从 SQLite 删)
            const res = removeLocalPermission(targetQQ, botId);
            if (!res.success) return `❌ 删除失败: ${res.error}`;
            
            // 注意：即使数据库里没数据，better-sqlite3 的 delete 也是成功，可以顺便查一下是否为空，或者直接返回成功。
            return `✅ 已删除 ${targetQQ} 在 Bot [${botId}] 的局部身份`;
        }
    },

    // 5. 权限状态查询与开关
    async handlePermission(args, senderQQ, targetQQFromAt) {
        const config = loadConfig();
        const masterQQ = getMasterQQ(config);
        
        const action = ['开', '关', '查询'].includes(args[1]) ? args[1] : '查询';
        
        let restArgs = [...args];
        if (['开', '关', '查询'].includes(restArgs[1])) {
            restArgs.splice(1, 1);
        }
        const { targetQQ, botId } = parseArgs(restArgs, targetQQFromAt);
        const finalTarget = targetQQ || String(senderQQ);

        if (action === '查询') {
            const owners = config.permissions?.owners || {};
            const permStatus = config.permissions?.owner_permission || {};
            
            const globalVal = owners[finalTarget];
            // 🌟 从数据库拉取这个人的所有局部权限
            const localList = listUserPermissions(finalTarget);

            if (globalVal === undefined && localList.length === 0) return `❌ ${finalTarget} 不是主人`;

            let res = `📌 【${finalTarget}】的权限状态：\n`;
            
            // 全局状态
            if (globalVal === true) {
                res += `👑 全局身份：大主人（所有 Bot 可用）\n`;
            } else if (globalVal === false) {
                const status = Number(permStatus[finalTarget]) === 0 ? '❌ 关闭（无权限）' : '✅ 开启（全局小主人）';
                res += `🌐 全局身份：小主人\n当前状态：${status}\n`;
            }

            // 局部状态
            if (localList.length > 0) {
                res += `🎯 局部身份：\n`;
                localList.forEach(item => {
                    const rName = item.role === 'owner' ? '小主人' : '大主人';
                    res += `  - Bot [${item.bot_id}]：${rName}\n`;
                });

                if (botId) {
                    const matched = localList.find(item => item.bot_id === botId);
                    if (matched) res += `\n👉 在 Bot [${botId}] 上：✅ 有权 (${matched.role === 'owner' ? '小主人' : '大主人'})`;
                    else res += `\n👉 在 Bot [${botId}] 上：❌ 无权`;
                }
            } else if (botId) {
                res += `\n👉 在 Bot [${botId}] 上：❌ 无权`;
            }
            
            return res;
        }

        // 开/关操作 (只能修改全局小主人的状态)
        if (String(senderQQ) !== String(masterQQ)) return '❌ 只有全局大主人可以修改权限状态';
        const owners = config.permissions?.owners || {};
        if (owners[finalTarget] === undefined) return `❌ ${finalTarget} 没有全局身份，无法操作`;
        if (owners[finalTarget] === true) return '❌ 全局大主人权限永久开启，无法修改';

        ensurePermissions(config);
        if (action === '开') {
            config.permissions.owner_permission[finalTarget] = 1;
            saveConfig(config);
            return `✅ 已开启 ${finalTarget} 的全局小主人权限`;
        } else {
            config.permissions.owner_permission[finalTarget] = 0;
            saveConfig(config);
            return `✅ 已关闭 ${finalTarget} 的全局小主人权限`;
        }
    }
};