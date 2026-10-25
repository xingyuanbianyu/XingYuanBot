// 🌟 修复 1：使用标准 ESM 导入，抛弃 process.cwd() 的玄学路径
import { hasPermission, getRole } from '../../../../xy-config/config/permissions.js';

let isTaskRunning = false; // 🌟 修复 4：并发锁

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
                // 兜底
                isMaster = ['master'].includes(getRole(senderQQ));
            }

            if (!isMaster) {
                return '❌ 权限不足：该指令仅限【大主人】使用。';
            }

            if (typeof globalThis.wsCall !== 'function') {
                return '❌ 框架网络层未就绪，无法调用 WS API。';
            }

            // 🌟 修复 4：拦截并发执行
            if (isTaskRunning) {
                return '⚠️ 打卡任务正在执行中，请勿重复触发！';
            }

            // 🌟 修复 2：转为后台异步执行
            isTaskRunning = true;
            
            // 立即回消息，让用户安心
            globalThis.bot.send({ 
                chatId: msg.chatId, 
                isGroup: msg.isGroup, 
                content: '⏳ 群打卡任务已在后台启动，执行完毕后我会汇报结果！',
                botId: msg.botId,
                _ws: msg._ws
            });

            // 使用 IIFE (立即执行函数) 启动后台任务，不阻塞当前 return
            (async () => {
                const sleepFn = globalThis.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
                const randomFn = globalThis.random || ((min, max) => Math.floor(Math.random() * (max - min + 1)) + min);

                const logBuffer = [];
                let successCount = 0;
                let failCount = 0;

                try {
                    // 🌟 修复 3：所有 wsCall 传入 msg._ws，确保精准投递
                    const groupListRes = await globalThis.wsCall('get_group_list', {}, 10000, msg._ws);
                    if (!groupListRes || (groupListRes.status !== 'ok' && groupListRes.retcode !== 0)) {
                        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: '✖ 获取群列表失败！请检查 NapCat 是否正常运行。', botId: msg.botId, _ws: msg._ws });
                        return;
                    }

                    const groups = groupListRes.data || [];
                    if (groups.length === 0) {
                        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: '✖ 机器人当前没有加入任何群！', botId: msg.botId, _ws: msg._ws });
                        return;
                    }

                    logBuffer.push(`========================================`);
                    logBuffer.push(`开始执行群打卡，共 ${groups.length} 个群`);

                    for (const group of groups) {
                        try {
                            await sleepFn(randomFn(400, 1000));
                            let isSignSuccess = false;

                            // 使用 msg._ws 发 API
                            try {
                                const signRes = await globalThis.wsCall('set_group_sign', { group_id: String(group.group_id) }, 5000, msg._ws);
                                if (signRes.status === 'ok' || signRes.retcode === 0) isSignSuccess = true;
                            } catch (e) {}

                            if (!isSignSuccess) {
                                try {
                                    const llobotRes = await globalThis.wsCall('send_group_sign', { group_id: Number(group.group_id) }, 5000, msg._ws);
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

                    // 任务完成，私聊或群里汇报结果
                    globalThis.bot.send({ 
                        chatId: msg.chatId, 
                        isGroup: msg.isGroup, 
                        content: `✅ 群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`,
                        botId: msg.botId,
                        _ws: msg._ws
                    });

                } catch (err) {
                    console.error('[daily-tool] 异常:', err.message || err);
                    globalThis.bot.send({ 
                        chatId: msg.chatId, 
                        isGroup: msg.isGroup, 
                        content: `✖ 批量打卡异常：${err.message}`, 
                        botId: msg.botId,
                        _ws: msg._ws
                    });
                } finally {
                    // 无论成功还是失败，必须释放锁
                    isTaskRunning = false;
                }
            })();

            // 立即返回 null，让 dispatcher 结束本轮
            return null;

        } catch (err) {
            console.error('[daily-tool] 顶层异常:', err.message || err);
            return `✖ 批量打卡异常：${err.message}`;
        }
    }
}

export default DailyTool;