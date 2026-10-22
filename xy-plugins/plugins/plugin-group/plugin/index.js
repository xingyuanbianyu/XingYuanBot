import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';

// 🌟 修复1：动态解析权限文件路径，防止因为插件被移动文件夹导致相对路径报错
let hasPermissionFn = null;
async function getPermissionModule() {
    if (hasPermissionFn) return hasPermissionFn;
    try {
        // 假设从项目根目录启动，定位到 xy-config/config/permissions.js
        const permissionPath = path.resolve(process.cwd(), 'xy-config', 'config', 'permissions.js');
        if (fs.existsSync(permissionPath)) {
            const mod = await import(pathToFileURL(permissionPath).href);
            hasPermissionFn = mod.hasPermission;
            return hasPermissionFn;
        }
    } catch (e) {
        console.error('[daily-tool] 加载权限模块失败:', e.message);
    }
    // 兜底：如果加载失败，返回一个永远拒绝的函数，防止越权
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
        const senderQQ = String(msg.senderQQ || msg.user_id || msg.senderId || '');
        
        // 动态获取权限校验函数
        const checkPermission = await getPermissionModule();
        
        // 🌟 核心修复：将 'owner' 改为 'master'！仅限大主人使用
        if (!checkPermission(senderQQ, 'master')) {
            return '❌ 权限不足：该指令仅限【大主人】使用。';
        }

        // 🌟 核心升级：检查框架是否支持 WebSocket 直连调用
        if (typeof globalThis.wsCall !== 'function') {
            return '❌ 框架网络层未就绪，无法调用 WS API。请确保已更新 network.js 并成功连接。';
        }

        const sleepFn = globalThis.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
        const randomFn = globalThis.random || ((min, max) => Math.floor(Math.random() * (max - min + 1)) + min);

        try {
            // 🌟 使用 wsCall 获取群列表 (自动带有 network.js 里的 15 秒超时控制)
            const groupListRes = await globalThis.wsCall('get_group_list');
            if (!groupListRes || (groupListRes.status !== 'ok' && groupListRes.retcode !== 0)) {
                return '✖ 获取群列表失败！请检查 NapCat 是否正常运行。';
            }

            const groups = groupListRes.data;
            if (!groups || groups.length === 0) {
                return '✖ 机器人当前没有加入任何群！';
            }

            const logBuffer = [];
            logBuffer.push(`========================================`);
            logBuffer.push(`开始执行群打卡，共 ${groups.length} 个群`);

            let successCount = 0;
            let failCount = 0;

            for (const group of groups) {
                try {
                    // 随机延迟，防风控
                    await sleepFn(randomFn(400, 1000));
                    let isSignSuccess = false;

                    // 尝试 1：使用标准 API
                    try {
                        const signRes = await globalThis.wsCall('set_group_sign', {
                            group_id: String(group.group_id)
                        });
                        if (signRes.status === 'ok' || signRes.retcode === 0) {
                            isSignSuccess = true;
                        }
                    } catch (e) {}

                    // 尝试 2：兼容部分协议端的旧接口
                    if (!isSignSuccess) {
                        try {
                            const llobotRes = await globalThis.wsCall('send_group_sign', {
                                group_id: Number(group.group_id)
                            });
                            if (llobotRes.status === 'ok' || llobotRes.retcode === 0) {
                                isSignSuccess = true;
                            }
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
            if (typeof globalThis.writeLog === 'function') {
                globalThis.writeLog('daily-tool', finalLogContent);
            } else {
                console.log(finalLogContent);
            }

            return `群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`;

        } catch (err) {
            console.error('[daily-tool] 异常:', err.message || err);
            if (typeof globalThis.writeLog === 'function') {
                globalThis.writeLog('daily-tool', `❌ 执行异常: ${err.message}`);
            }
            return '✖ 批量打卡异常，请查看后台日志。';
        }
    }
}

export default DailyTool;