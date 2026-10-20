import { hasPermission } from '../../../../xy-config/config/permissions.js';

class DailyTool {
    constructor(napcatConfig) {
        this.pluginConfig = napcatConfig;
        this.apiBase = 'http://127.0.0.1:3000';
    }

    async napcatGet(action, params = {}) {
        const url = new URL(`${this.apiBase}/${action}`);
        Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
        const res = await fetch(url);
        return await res.json();
    }

    match(text) {
        if (typeof text !== 'string') return false;
        return text.trim() === '群打卡';
    }

    async handle(msg) {
        const senderQQ = String(msg.senderQQ || msg.user_id || msg.senderId || '');
        
        // 🌟 核心修复：将 'owner' 改为 'master'！
        // 这样只有配置文件里标记为 true 的大主人才能触发，小主人发会被直接拦截。
        if (!hasPermission(senderQQ, 'master')) {
            return '❌ 权限不足：该指令仅限【大主人】使用。';
        }

        const sleepFn = globalThis.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
        const randomFn = globalThis.random || ((min, max) => Math.floor(Math.random() * (max - min + 1)) + min);

        try {
            const groupListRes = await this.napcatGet('get_group_list');
            if (!groupListRes || groupListRes.status !== 'ok') {
                return '✖ 获取群列表失败！';
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
                    await sleepFn(randomFn(400, 1000));
                    let isSignSuccess = false;

                    try {
                        const signRes = await this.napcatGet('set_group_sign', {
                            group_id: String(group.group_id)
                        });
                        if (signRes.status === 'ok' || signRes.retcode === 0) {
                            isSignSuccess = true;
                        }
                    } catch (e) {}

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
            return '✖ 批量打卡异常';
        }
    }
}

export default DailyTool;