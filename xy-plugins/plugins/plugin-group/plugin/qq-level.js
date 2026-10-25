export default {
    name: 'QQ等级查询',
    description: '精准获取真实QQ等级（太阳月亮）',

    match(text) {
        if (!text || typeof text !== 'string') return false;
        return text.trim().startsWith('查QQ等级');
    },

    async handle(msg) {
        const cmd = (msg.pureText || "").trim();
        const selfId = String(msg.botId || msg.selfId || '');
        const senderQQ = String(msg.senderQQ || msg.user_id || '');
        
        // 1. 提取目标 QQ
        let targetQQ = null;
        
        // 优先从 @ 中提取
        if (Array.isArray(msg.message)) {
            const at = msg.message.find(item => item?.type === 'at');
            // 🌟 修复 1：过滤掉 @全体成员 (qq = all)
            if (at && at.data?.qq && at.data.qq !== 'all') {
                targetQQ = String(at.data.qq);
            }
        }
        
        // 其次从指令后面的文本提取
        if (!targetQQ) {
            // 🌟 修复 2：只在去掉指令头之后提取数字，避免拿到垃圾数字
            const args = cmd.replace('查QQ等级', '').trim();
            const match = args.match(/(\d{5,12})/);
            if (match) targetQQ = match[1];
        }
        
        // 最后兜底：查发送者自己
        if (!targetQQ) targetQQ = senderQQ;

        if (!targetQQ) return '⚠️ 无法确定要查询的 QQ 号。';

        // 🌟 修复 3：拦截查询机器人自己（API 通常查不到自己的等级）
        if (selfId && targetQQ === selfId) {
            return `🤖 正在查询的账号是机器人自己，无法获取真实 QQ 等级哦~`;
        }

        let levelNum = null;

        // 2. 优先查询：群成员信息
        if (msg.isGroup) {
            try {
                // 🌟 修复 4：传入 msg._ws，确保多号环境下不串台
                const res = await globalThis.wsCall('get_group_member_info', { 
                    group_id: Number(msg.chatId), 
                    user_id: Number(targetQQ), 
                    no_cache: true 
                }, 5000, msg._ws);
                
                // 🌟 修复 5：兼容 qq_level / qqLevel / level 三种字段名
                const data = res?.data || {};
                const qqLevel = data.qq_level ?? data.qqLevel ?? data.level;
                
                if (qqLevel !== undefined && qqLevel !== null) {
                    levelNum = parseInt(qqLevel);
                }
            } catch (e) {}
        }

        // 3. 备用查询：陌生人信息（如果群查失败，或者私聊）
        if (levelNum === null || isNaN(levelNum)) {
            try {
                const res = await globalThis.wsCall('get_stranger_info', { 
                    user_id: Number(targetQQ), 
                    no_cache: true 
                }, 5000, msg._ws);
                
                const data = res?.data || {};
                const qqLevel = data.qq_level ?? data.qqLevel ?? data.level;
                
                if (qqLevel !== undefined && qqLevel !== null) {
                    levelNum = parseInt(qqLevel);
                }
            } catch (e) {}
        }

        // 4. 如果全都没拿到
        if (levelNum === null || isNaN(levelNum)) {
            return `❌ 查询失败：可能是对方隐藏了等级，或接口暂不支持获取。\n（目标账号: ${targetQQ}）`;
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