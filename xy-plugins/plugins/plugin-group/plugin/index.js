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

    match(data) {
        const text = typeof data === 'string' ? data.trim() : (data.text?.trim() || '');
        return text === '#群打卡';
    }

    async handle(data) {
        // 权限校验
        const senderQQ = String(data.senderId ?? data.senderQQ ?? data.user_id ?? '');
        if (!hasPermission(senderQQ, 'master')) {
            return { type: 'reply', message: '❌ 权限不足：该指令仅限大主人使用。' };
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

            // 🌟 核心改动 1：创建一个内存数组，用来暂存这一轮打卡的所有日志
            const logBuffer = [];
            logBuffer.push(`========================================`);
            logBuffer.push(`开始执行群打卡，共 ${groups.length} 个群`);

            let successCount = 0;
            let failCount = 0;

            for (const group of groups) {
                // 🌟 核心改动：在循环开始就提取群名
                const groupName = group.group_name || '未知群名';
                
                try {
                    // 随机延迟防风控
                    await sleep(random(400, 1000));
                    let isSignSuccess = false;

                    // 尝试 1：NapCat 风格
                    try {
                        const signRes = await this.napcatGet('set_group_sign', {
                            group_id: String(group.group_id)
                        });
                        if (signRes.status === 'ok' || signRes.retcode === 0) {
                            isSignSuccess = true;
                        }
                    } catch (e) {}

                    // 尝试 2：LLOneBot 风格
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
                        } catch (e) {}
                    }

                    // 🌟 核心改动 2：日志里带上群名和群号
                    if (isSignSuccess) {
                        successCount++;
                        logBuffer.push(`✅ ${groupName} (${group.group_id}) 打卡成功`);
                    } else {
                        failCount++;
                        logBuffer.push(`❌ ${groupName} (${group.group_id}) 打卡失败`);
                    }

                } catch (error) {
                    failCount++;
                    logBuffer.push(`❌ ${groupName} (${group.group_id}) 打卡异常: ${error.message}`);
                }
            }

            logBuffer.push(`🏁 群打卡结束！成功 ${successCount} 个，失败 ${failCount} 个`);
            logBuffer.push(`========================================\n`);

            // 🌟 核心改动 3：循环全部结束后，把数组拼接成完整字符串，只调用一次 writeLog！
            const finalLogContent = logBuffer.join('\n');
            writeLog('daily-tool', finalLogContent);

            return {
                type: 'reply',
                message: `群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`
            };
        } catch (err) {
            console.error('[daily-tool] 异常:', err.message || err);
            // 这里作为兜底，也走一次日志
            writeLog('daily-tool', `❌ 执行异常: ${err.message}`);
            return { type: 'reply', message: '✖ 批量打卡异常' };
        }
    }
}

export default DailyTool;