// xy-plugins/QQ/qq-level/index.js
export default {
    name: 'QQ等级查询',
    description: '精准获取真实QQ等级（太阳月亮）',

    match(text) {
        if (!text || typeof text !== 'string') return false;
        return text.trim().startsWith('查QQ等级');
    },

    async handle(msg) {
        const cmd = (msg.pureText || "").trim();
        
        // 1. 提取目标 QQ
        let targetQQ = null;
        if (Array.isArray(msg.message)) {
            const at = msg.message.find(item => item?.type === 'at');
            if (at && at.data?.qq) targetQQ = String(at.data.qq);
        }
        if (!targetQQ) {
            const match = cmd.match(/(?<!\d)(\d{5,12})(?!\d)/);
            if (match) targetQQ = match[1];
        }
        if (!targetQQ) targetQQ = String(msg.senderQQ);

        let levelNum = null;

        // 2. 优先查询：群成员信息（群友直接查，字段最稳）
        if (msg.isGroup) {
            try {
                const res = await globalThis.wsCall('get_group_member_info', { 
                    group_id: Number(msg.chatId), 
                    user_id: Number(targetQQ), 
                    no_cache: true 
                });
                // 🌟 核心字段：qq_level
                const qqLevel = res?.data?.qq_level || res?.data?.qqLevel;
                if (qqLevel !== undefined && qqLevel !== null) {
                    levelNum = parseInt(qqLevel);
                }
            } catch (e) {}
        }

        // 3. 备用查询：如果是陌生人或者群查失败了，查陌生人信息
        if (levelNum === null) {
            try {
                const res = await globalThis.wsCall('get_stranger_info', { 
                    user_id: Number(targetQQ), 
                    no_cache: true 
                });
                // 陌生人信息里，如果有 qqLevel 就拿，没有就拉倒
                const data = res?.data || {};
                if (data.qqLevel !== undefined && data.qqLevel !== null) {
                    levelNum = parseInt(data.qqLevel);
                }
            } catch (e) {}
        }

        // 4. 如果全都没拿到
        if (levelNum === null) {
            return `❌ 查询失败：可能是对方隐藏了等级，或不是群成员导致无法获取。`;
        }

        // 5. 计算太阳、月亮、星星
        const sun = Math.floor(levelNum / 16);
        const moon = Math.floor((levelNum % 16) / 4);
        const star = levelNum % 4;
        
        const icons = '☀️'.repeat(sun) + '🌙'.repeat(moon) + '⭐'.repeat(star);

        return `✨ QQ 等级查询结果\n\n` +
               `👤 目标账号：${targetQQ}\n` +
               `📈 当前等级：Lv.${levelNum}\n` +
               `🎖️ 等级图标：${icons || '🌑'}`;
    }
};