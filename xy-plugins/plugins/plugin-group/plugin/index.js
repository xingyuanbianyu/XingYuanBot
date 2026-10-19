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

    // ✅ 底层已经剥离了前缀（如 # 或 /），这里直接匹配纯文本
    match(text) {
        if (typeof text !== 'string') return false;
        return text.trim() === '群打卡';
    }

    // ✅ 接收完整的 msg 对象，以便提取发送者 QQ
    async handle(msg) {
        const senderQQ = String(msg.senderQQ || msg.user_id || msg.senderId || '');
        
        // ✅ 修正权限校验：如果当前用户不是大主人或小主人，就拦截
        if (!hasPermission(senderQQ, 'owner')) {
            return '❌ 权限不足：该指令仅限主人使用。';
        }

        // ✅ 兜底获取全局工具（防止 lib.cjs 没挂载成功报错）
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
                    // 随机延迟防风控
                    await sleepFn(randomFn(400, 1000));
                    let isSignSuccess = false;

                    // 尝试 1：NapCat 风格 (GET /set_group_sign)
                    try {
                        const signRes = await this.napcatGet('set_group_sign', {
                            group_id: String(group.group_id)
                        });
                        if (signRes.status === 'ok' || signRes.retcode === 0) {
                            isSignSuccess = true;
                        }
                    } catch (e) {}

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
                        } catch (e) {}
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

            // 一次性调用全局 writeLog 写入文件
            const finalLogContent = logBuffer.join('\n');
            if (typeof globalThis.writeLog === 'function') {
                globalThis.writeLog('daily-tool', finalLogContent);
            } else {
                console.log(finalLogContent);
            }

            // ✅ 核心优化：直接返回字符串，app.js 会自动识别并发送
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