import { hasPermission } from '../../../xy-config/config/permissions.js';

class DailyTool {
    constructor(pluginConfig) {
        this.pluginConfig = pluginConfig;
        // 你的 NapCatQQ / LLOneBot API 基础地址（请根据实际情况修改端口）
        this.apiBase = 'http://127.0.0.1:3000'; 
    }

    async handle(data) {
        const text = data.text?.trim() || '';

        // 只处理 #群打卡 指令
        if (text !== '#群打卡') return null;

        // 权限：只有大主人能用
        if (!hasPermission(data.senderQQ, 'master')) {
            return { type: 'reply', message: '❌ 你没有权限使用此功能' };
        }

        try {
            // 1. 获取机器人的所有群列表
            const groupListResponse = await fetch(`${this.apiBase}/get_group_list`);
            const groupData = await groupListResponse.json();
            
            if (groupData.status !== 'ok' || !groupData.data) {
                return { type: 'reply', message: '❌ 获取群列表失败，请检查 NapCatQQ 是否正常运行' };
            }

            const groups = groupData.data;
            if (groups.length === 0) {
                return { type: 'reply', message: 'ℹ️ 机器人当前没有加入任何群' };
            }

            let successCount = 0;
            let failCount = 0;

            // 2. 遍历每一个群，执行群签到 (打卡)
            for (const group of groups) {
                const groupId = group.group_id;
                try {
                    // NapCatQQ 原生群打卡接口
                    await fetch(`${this.apiBase}/set_group_sign`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ group_id: groupId })
                    });
                    successCount++;
                } catch (e) {
                    failCount++;
                }
            }

            // 3. 返回统计结果
            return {
                type: 'reply',
                message: `✅ 群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个`
            };

        } catch (err) {
            console.error('[daily-tool] 批量打卡异常:', err);
            return {
                type: 'reply',
                message: '❌ 批量打卡请求失败，请检查 API 地址是否正确'
            };
        }
    }
}

export default DailyTool;
