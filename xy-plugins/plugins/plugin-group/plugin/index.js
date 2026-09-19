// import { hasPermission } from '../../../xy-config/config/permissions.js'; // 权限判断已改为使用 data.role，此行可注释
import axios from 'axios'; // 已不再使用 axios，但保留导入以防其他地方需要

class DailyTool {
    constructor(napcatConfig) {
        this.pluginConfig = napcatConfig;
        this.apiBase = 'http://127.0.0.1:3000'; // 确保端口正确
    }

    /**
     * 使用 fetch 发送 GET 请求，与你的其他插件风格保持一致
     * @param {string} action API 动作名称，如 'get_group_list'
     * @param {Object} params 查询参数
     * @returns {Promise<Object>} API 响应数据
     */
    async napcatGet(action, params = {}) {
        const url = new URL(`${this.apiBase}/${action}`);
        // 将参数拼接到 URL 查询字符串中
        Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
        
        const res = await fetch(url);
        const data = await res.json();
        return data;
    }

    match(data) {
        const text = typeof data === 'string' ? data.trim() : (data.text?.trim() || '');
        return text === '#群打卡';
    }

    async handle(data) {
        // 直接使用 data.role 进行权限判断，更直接
        if (data.role !== 'master') {
            return null; // 非主人静默忽略
        }

        try {
            // 使用新的 napcatGet 方法
            const groupListRes = await this.napcatGet('get_group_list');
            
            if (!groupListRes || groupListRes.status !== 'ok') {
                return { type: 'reply', message: '✖ 获取群列表失败，请检查 NapCatQQ 是否正在运行！' };
            }

            const groups = groupListRes.data; 

            if (!groups || groups.length === 0) {
                return { type: 'reply', message: '✖ 机器人当前没有加入任何群！' };
            }

            let successCount = 0;
            let failCount = 0;

            for (const group of groups) {
                try {
                    // 打卡接口也使用 GET 方式调用
                    await sleep(random(400, 3000));
                    const signRes = await this.napcatGet('set_group_sign', {
                        group_id: String(group.group_id)
                    });
                    
                    if (signRes.status === 'ok') {
                        successCount++;
                    } else {
                        failCount++;
                        console.error(`[daily-tool] 群 ${group.group_id} 打卡失败:`, signRes.message || '未知错误');
                    }
                } catch (e) {
                    failCount++;
                    console.error(`[daily-tool] 群 ${group.group_id} 打卡异常:`, e.message || e);
                }
            }

            return {
                type: 'reply',
                message: `群打卡任务完成！\n共 ${groups.length} 个群，成功 ${successCount} 个，失败 ${failCount} 个。`
            };
        } catch (err) {
            console.error('[daily-tool] 批量打卡异常:', err.message || err);
            return {
                type: 'reply',
                message: '✖ 批量打卡请求失败，请检查 API 地址是否正确'
            };
        }
    }
}

export default DailyTool;
