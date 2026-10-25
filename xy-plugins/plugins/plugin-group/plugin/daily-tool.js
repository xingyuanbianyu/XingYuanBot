import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';

let hasPermissionFn = null;
async function getPermissionModule() {
    if (hasPermissionFn) return hasPermissionFn;
    try {
        const permissionPath = path.resolve(process.cwd(), 'xy-config', 'config', 'permissions.js');
        if (fs.existsSync(permissionPath)) {
            const mod = await import(pathToFileURL(permissionPath).href);
            hasPermissionFn = mod.hasPermission || mod.getRole || mod.default;
            return hasPermissionFn;
        } else {
            // 兜底尝试另一个路径
            const altPath = path.resolve(process.cwd(), 'xy-config', 'permissions.js');
            if (fs.existsSync(altPath)) {
                const mod = await import(pathToFileURL(altPath).href);
                hasPermissionFn = mod.hasPermission || mod.getRole || mod.default;
                return hasPermissionFn;
            }
        }
    } catch (e) {
        console.error('[daily-tool] 加载权限模块失败:', e.message);
    }
    return () => false; 
}

class DailyTool {
    constructor(napcatConfig) {
        this.pluginConfig = napcatConfig;
    }

    match(text) {
        if (typeof text !== 'string') return false;
        return text.trim() === '群打卡';
    }

    async handle(msg) {
        try {
            const senderQQ = String(msg.senderQQ || msg.user_id || msg.senderId || '');
            
            // 🌟 修复1：权限校验更稳妥，加 try-catch
            const checkPermission = await getPermissionModule();
            let isMaster = false;
            try {
                if (typeof checkPermission === 'function') {
                    isMaster = checkPermission(senderQQ, 'master');
                } else if (typeof checkPermission === 'object' && typeof checkPermission.getRole === 'function') {
                    isMaster = ['master', 'owner'].includes(checkPermission.getRole(senderQQ));
                }
            } catch (e) {}

            if (!isMaster) {
                return '❌ 权限不足：该指令仅限【大主人】使用。';
            }

            if (typeof globalThis.wsCall !== 'function') {
                return '❌ 框架网络层未就绪，无法调用 WS API。';
            }

            const sleepFn = globalThis.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
            const randomFn = globalThis.random || ((min, max) => Math.floor(Math.random() * (max - min + 1)) + min);

            // 🌟 修复2：先用纯文本回一句，告诉群友我开始干活了
            globalThis.bot.send({ chatId: msg.chatId, isGroup: true, content: '⏳ 正在为所有群执行打卡，请稍候...' });

            const groupListRes = await globalThis.wsCall('get_group_list');
            if (!groupListRes || (groupListRes.status !== 'ok' && groupListRes.retcode !== 0)) {
                return '✖ 获取群列表失败！请检查 NapCat 是否正常运行。';
            }

            const groups = groupListRes.data || [];
            if (groups.length === 0) {
                return '✖ 机器人当前没有加入任何群！';
            }

            const logBuffer = [];
            logBuffer.push(`========================================`);
            logBuffer.push(`开始执行群打卡，共 ${groups.length} 个群`);

            let successCount = 0;
            let failCount = 0;

            for (const group of groups) {
                try {
                    await sleepFn(randomFn(400, 1000));
                    let isSignSuccess = false;

                    try {
                        const signRes = await globalThis.wsCall('set_group_sign', { group_id: String(group.group_id) });
                        if (signRes.status === 'ok' || signRes.retcode === 0) isSignSuccess = true;
                    } catch (e) {}

                    if (!isSignSuccess) {
                        try {
                            const llobotRes = await globalThis.wsCall('send_group_sign', { group_id: Number(group.group_id) });
                            if (llobotRes.status === 'ok' || llobotRes.retcode === 0) isSignSuccess = true;
                        } catch (e) {}
                    }

                    const groupName = group.group_name || '未知群名';
                    if (isSignSuccess) {
                        successCount++;
                        logBuffer.push(`✅ ${groupName} (${group.group_id}) 打卡成功`);
                    } else {
                        failCount++;
                        logBuffer.push(`❌ ${groupName} (${group.group_id}) 打卡失败`);
                    }
                } catch (error) {
                    failCount++;
                    const groupName = group.group_name || '未知群名';
                    logBuffer.push(`❌ ${groupName} (${group.group_id}) 打卡异常: ${error.message}`);
                }
            }

            logBuffer.push(`🏁 群打卡结束！成功 ${successCount} 个，失败 ${failCount} 个`);
            logBuffer.push(`========================================\n`);

            const finalLogContent = logBuffer.join('\n');
            if (typeof globalThis.writeLog === 'function') globalThis.writeLog('daily-tool', finalLogContent);
            else console.log(finalLogContent);

            return `✅ 群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`;

        } catch (err) {
            console.error('[daily-tool] 异常:', err.message || err);
            return `✖ 批量打卡异常：${err.message}`; // 🌟 修复3：异常直接返回给群聊，绝不装死
        }
    }
}

export default DailyTool;