import { hasPermission } from '../../../../xy-config/config/permissions.js';

class DailyTool {
    constructor(napcatConfig) {
        this.pluginConfig = napcatConfig;
        this.apiBase = 'http://127.0.0.1:3000';
    }

    /**
     * 统一 GET 请求封装
     */
    async napcatGet(action, params = {}) {
        const url = new URL(`${this.apiBase}/${action}`);
        Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
        const res = await fetch(url);
        return await res.json();
    }

    // 🌟 核心修复 1：底层已经剥离了前缀（如 # 或 /），这里直接匹配纯文本
    match(text) {
        if (typeof text !== 'string') return false;
        return text.trim() === '群打卡';
    }

    // 🌟 核心修复 2：接收完整的 msg 对象，以便提取发送者 QQ
    async handle(msg) {
        const senderQQ = String(msg.senderQQ || msg.user_id || msg.senderId || '');
        
        // 🌟 核心修复 3：修正权限校验，如果当前用户不是大主人或小主人，就拦截
        if (!hasPermission(senderQQ, 'owner')) {
            return { type: 'reply', message: '❌ 权限不足：该指令仅限主人使用。' };
        }

        try {
            const groupListRes = await this.napcatGet('get_group_list');
            if (!groupListRes || groupListRes.status !== 'ok') {
                return { type: 'reply', message: '✖ 获取群列表失败！' };
            }

            const groups = groupListRes.data;
            if (!groups || groups.length === 0) {
                return { type: 'reply', message: '✖ 机器人当前没有加入任何群！' };
            }

            // 🌟 核心修复 4：恢复内存日志缓冲，防止频繁 IO
            const logBuffer = [];
            logBuffer.push(`========================================`);
            logBuffer.push(`开始执行群打卡，共 ${groups.length} 个群`);

            let successCount = 0;
            let failCount = 0;

            for (const group of groups) {
                try {
                    // 随机延迟防风控
                    await sleep(random(400, 1000));
                    let isSignSuccess = false;

                    // 尝试 1：NapCat 风格 (GET /set_group_sign)
                    try {
                        const signRes = await this.napcatGet('set_group_sign', {
                            group_id: String(group.group_id)
                        });
                        if (signRes.status === 'ok' || signRes.retcode === 0) {
                            isSignSuccess = true;
                        }
                    } catch (e) {
                        // 失败自动进入下一步
                    }

                    // 尝试 2：LLOneBot 风格 (POST /send_group_sign)
                    if (!isSignSuccess) {
                        try {
                            const llobotRes = await fetch(`${this.apiBase}/send_group_sign`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ group_id: Number(group.group_id) })
                            });
                            const llobotData = await llobotRes.json();
                            if (llobotData.status === 'ok' || llobotData.retcode === 0) {
                                isSignSuccess = true;
                            }
                        } catch (e) {
                            // 失败自动跳过
                        }
                    }

                    // 统计结果并推入内存缓冲
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

            // 🌟 核心修复 5：循环结束后，一次性调用全局 writeLog 写入文件
            const finalLogContent = logBuffer.join('\n');
            if (typeof globalThis.writeLog === 'function') {
                globalThis.writeLog('daily-tool', finalLogContent);
            } else {
                console.log(finalLogContent); // 兜底
            }

            return {
                type: 'reply',
                message: `群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`
            };
        } catch (err) {
            console.error('[daily-tool] 异常:', err.message || err);
            // 异常时也写一条日志
            if (typeof globalThis.writeLog === 'function') {
                globalThis.writeLog('daily-tool', `❌ 执行异常: ${err.message}`);
            }
            return { type: 'reply', message: '✖ 批量打卡异常' };
        }
    }
}

export default DailyTool;