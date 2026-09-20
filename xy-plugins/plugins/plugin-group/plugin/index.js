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
        if (hasPermission('master')) return null;

        try {
            const groupListRes = await this.napcatGet('get_group_list');
            if (!groupListRes || groupListRes.status !== 'ok') {
                return { type: 'reply', message: '✖ 获取群列表失败！' };
            }

            const groups = groupListRes.data;
            if (!groups || groups.length === 0) {
                return { type: 'reply', message: '✖ 机器人当前没有加入任何群！' };
            }

            let successCount = 0;
            let failCount = 0;

            for (const group of groups) {
                try {
                    // 随机延迟防风控
                    await sleep(random(400, 1000));
                    let isSignSuccess = false;

                    // ==========================================
                    // 【双保险自动适配逻辑】
                    // ==========================================

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

                    // 统计结果
                    if (isSignSuccess) {
                        successCount++;
                    } else {
                        failCount++;
                    }

                } catch (error) {
                    failCount++;
                }
            }

            return {
                type: 'reply',
                message: `群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`
            };
        } catch (err) {
            console.error('[daily-tool] 异常:', err.message || err);
            return { type: 'reply', message: '✖ 批量打卡异常' };
        }
    }
}

export default DailyTool;
