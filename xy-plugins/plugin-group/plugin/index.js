import { hasPermission } from '../../../xy-config/config/permissions.js';
import axios from 'axios';

class DailyTool {
    constructor(pluginConfig) {
        this.pluginConfig = pluginConfig;
        // NapCatQQ 的 HTTP 服务地址
        this.apiBase = 'http://127.0.0.1:3000'; 
    }

    // 1. 补上 match 方法，让 PluginGroup 能识别到它
    match(data) {
        // 处理 data 可能是字符串的情况
        const text = typeof data === 'string' ? data.trim() : (data.text?.trim() || '');
        return text === '#群打卡' || text === '群打卡';
    }

    async handle(data) {
        const text = typeof data === 'string' ? data.trim() : (data.text?.trim() || '');

        // 只处理指定的指令
        if (text !== '群打卡' && text !== '#群打卡') return null;

        // 2. 权限校验（请确保你的 permissions.js 逻辑正常）
        // 注意：这里假设 data.senderQQ 是可用的。如果报错，可能需要从 context 或其他地方获取
        if (!hasPermission(data.senderQQ, 'master')) {
            return { type: 'reply', message: '❌ 你没有权限使用此功能' };
        }

        try {
            // ==========================================
            // 【标准调用 1】：获取群列表
            // 统一 POST 到根路径 /，在 body 中指定 action
            // ==========================================
            const groupListRes = await axios.post(`${this.apiBase}/`, {
                action: 'get_group_list',
                params: {}
            });

            const groupData = groupListRes.data;
            
            if (groupData.status !== 'ok' || !groupData.data) {
                return { type: 'reply', message: '❌ 获取群列表失败，请检查 NapCatQQ 是否正常运行' };
            }

            const groups = groupData.data;
            if (groups.length === 0) {
                return { type: 'reply', message: 'ℹ️ 机器人当前没有加入任何群' };
            }

            let successCount = 0;
            let failCount = 0;

            // 3. 遍历每一个群，执行群签到
            for (const group of groups) {
                const groupId = group.group_id;
                try {
                    // ==========================================
                    // 【标准调用 2】：群签到
                    // 同样 POST 到根路径 /，指定 action 和 params
                    // ==========================================
                    await axios.post(`${this.apiBase}/`, {
                        action: 'set_group_sign',
                        params: { 
                            group_id: String(groupId) // 传字符串更稳妥
                        }
                    });
                    successCount++;
                } catch (e) {
                    failCount++;
                    console.error(`[daily-tool] 群 ${groupId} 打卡失败:`, e.message || e);
                }
            }

            // 4. 返回统计结果
            return {
                type: 'reply',
                message: `✅ 群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个`
            };

        } catch (err) {
            console.error('[daily-tool] 批量打卡异常:', err.message || err);
            return {
                type: 'reply',
                message: '❌ 批量打卡请求失败，请检查 API 地址是否正确'
            };
        }
    }
}

export default DailyTool;
