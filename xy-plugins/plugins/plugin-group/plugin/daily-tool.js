// 🌟 修复 1：使用标准 ESM 导入
import { hasPermission, getRole } from '../../../../xy-config/config/permissions.js';

let isTaskRunning = false; // 🌟 并发锁

class DailyTool {
    constructor(pluginConfig) {
        this.pluginConfig = pluginConfig;
    }

    match(text) {
        if (typeof text !== 'string') return false;
        return text.trim() === '群打卡';
    }

    async handle(msg) {
        try {
            const senderQQ = String(msg.senderQQ || msg.user_id || msg.senderId || '');
            
            // 权限校验
            let isMaster = false;
            try {
                isMaster = hasPermission(senderQQ, 'master') || getRole(senderQQ) === 'master';
            } catch (e) {
                isMaster = ['master'].includes(getRole(senderQQ));
            }

            if (!isMaster) {
                return '❌ 权限不足：该指令仅限【大主人】使用。';
            }

            if (typeof globalThis.wsCall !== 'function') {
                return '❌ 框架网络层未就绪，无法调用 WS API。';
            }

            if (isTaskRunning) {
                return '⚠️ 打卡任务正在执行中，请勿重复触发！';
            }

            // 🌟 修复 2：安全获取 WS 对象（兼容不同的事件传参和框架共享状态）
            let ws = msg._ws || msg.ws;
            if (!ws && msg.botId && globalThis.sharedState?.botIdToWs) {
                ws = globalThis.sharedState.botIdToWs.get(String(msg.botId));
            }
            if (!ws) ws = globalThis.activeWs;

            if (!ws) {
                return '❌ 无法获取与 NapCat 的 WebSocket 连接（ws未就绪）。';
            }

            isTaskRunning = true;
            
            // 立即回消息
            globalThis.bot.send({ 
                chatId: msg.chatId, 
                isGroup: msg.isGroup, 
                content: '⏳ 群打卡任务已在后台启动，执行完毕后我会汇报结果！',
                botId: msg.botId,
                _ws: ws
            });

            // 使用 IIFE 启动后台任务
            (async () => {
                const sleepFn = globalThis.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
                const randomFn = globalThis.random || ((min, max) => Math.floor(Math.random() * (max - min + 1)) + min);

                const logBuffer = [];
                let successCount = 0;
                let failCount = 0;

                try {
                    // 🌟 修复 3：增加网络层 catch，并兼容不同框架的 group_list 返回格式
                    let groupListRes;
                    try {
                        groupListRes = await globalThis.wsCall('get_group_list', {}, 10000, ws);
                    } catch (wsErr) {
                        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: `✖ 获取群列表网络异常: ${wsErr.message || wsErr}`, botId: msg.botId, _ws: ws });
                        return;
                    }

                    // 兼容处理返回数据（有些框架返回数组，有些带 data 字段，有些嵌套更深）
                    let groups = groupListRes?.data;
                    if (!groups && Array.isArray(groupListRes)) groups = groupListRes;
                    if (!groups && groupListRes?.data?.data) groups = groupListRes.data.data;

                    if (!Array.isArray(groups)) {
                        const errDetail = groupListRes?.message || groupListRes?.wording || JSON.stringify(groupListRes);
                        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: `✖ 获取群列表失败！返回数据无法解析。\n返回值: ${errDetail}`, botId: msg.botId, _ws: ws });
                        return;
                    }

                    if (groups.length === 0) {
                        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: '✖ 机器人当前没有加入任何群！', botId: msg.botId, _ws: ws });
                        return;
                    }

                    logBuffer.push(`========================================`);
                    logBuffer.push(`开始执行群打卡，共 ${groups.length} 个群`);

                    for (const group of groups) {
                        try {
                            await sleepFn(randomFn(400, 1000));
                            let isSignSuccess = false;
                            // 确保群号是纯数字，有些接口传字符串会报错
                            const gid = Number(group.group_id || group.groupId); 

                            // 方案 A：NapCat / OneBot 11 标准接口
                            try {
                                const signRes = await globalThis.wsCall('set_group_sign', { group_id: gid }, 5000, ws);
                                if (signRes?.status === 'ok' || signRes?.retcode === 0 || signRes === null) isSignSuccess = true;
                            } catch (e) {}

                            // 方案 B：其他框架备用接口
                            if (!isSignSuccess) {
                                try {
                                    const llobotRes = await globalThis.wsCall('send_group_sign', { group_id: gid }, 5000, ws);
                                    if (llobotRes?.status === 'ok' || llobotRes?.retcode === 0 || llobotRes === null) isSignSuccess = true;
                                } catch (e) {}
                            }

                            const groupName = group.group_name || group.groupName || '未知群名';
                            if (isSignSuccess) {
                                successCount++;
                                logBuffer.push(`✅ ${groupName} (${gid}) 打卡成功`);
                            } else {
                                failCount++;
                                logBuffer.push(`❌ ${groupName} (${gid}) 打卡失败`);
                            }
                        } catch (error) {
                            failCount++;
                            const groupName = group.group_name || group.groupName || '未知群名';
                            logBuffer.push(`❌ ${groupName} (${group.group_id}) 打卡异常: ${error.message}`);
                        }
                    }

                    logBuffer.push(`🏁 群打卡结束！成功 ${successCount} 个，失败 ${failCount} 个`);
                    logBuffer.push(`========================================\n`);

                    const finalLogContent = logBuffer.join('\n');
                    if (typeof globalThis.writeLog === 'function') globalThis.writeLog('daily-tool', finalLogContent);
                    else console.log(finalLogContent);

                    // 汇报结果
                    globalThis.bot.send({ 
                        chatId: msg.chatId, 
                        isGroup: msg.isGroup, 
                        content: `✅ 群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`,
                        botId: msg.botId,
                        _ws: ws
                    });

                } catch (err) {
                    console.error('[daily-tool] 异常:', err.message || err);
                    globalThis.bot.send({ 
                        chatId: msg.chatId, 
                        isGroup: msg.isGroup, 
                        content: `✖ 批量打卡异常：${err.message}`, 
                        botId: msg.botId,
                        _ws: ws
                    });
                } finally {
                    isTaskRunning = false;
                }
            })();

            return null;

        } catch (err) {
            console.error('[daily-tool] 顶层异常:', err.message || err);
            return `✖ 批量打卡异常：${err.message}`;
        }
    }
}

export default DailyTool;