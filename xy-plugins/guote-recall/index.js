export default {
    name: "引用撤回",
    description: "回复消息 + 发送 #撤回",

    match: function (text, msg) {
        let txt = "";
        if (typeof text === "string") txt = text;
        else if (Array.isArray(text)) {
            for (let s of text) {
                if (s && s.type === "text") txt += (s.data && s.data.text ? s.data.text : "");
            }
        }
        return /#撤回/.test(txt.toLowerCase());
    },

    handle: async function (msg, matchResult) {
        console.log('[撤回] 开始执行');
        
        let text = msg.text || "";
        let m = text.match(/\[引用ID:(\d+)\]/);
        
        if (!m) {
            console.log('[撤回] 未找到引用ID');
            return;
        }

        let refId = parseInt(m[1]);
        let commandMsgId = msg.message_id;  // 指令消息本身的ID

        console.log(`[撤回] 目标消息ID: ${refId}`);
        console.log(`[撤回] 指令消息ID: ${commandMsgId}`);

        // ===== 1. 撤回被引用的消息 =====
        try {
            const res1 = await fetch('http://127.0.0.1:3000/delete_msg', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message_id: refId })
            });
            const result1 = await res1.json();
            if (result1.status === 'ok') {
                console.log('[撤回] ✅ 目标消息已撤回');
            } else {
                console.log('[撤回] ❌ 目标消息撤回失败:', result1);
            }
        } catch (err) {
            console.log('[撤回] ❌ 目标消息撤回异常:', err.message);
        }

        // ===== 2. 撤回指令消息本身 =====
        if (commandMsgId) {
            try {
                // 稍微延迟一下，避免两条撤回请求太快
                await new Promise(r => setTimeout(r, 300));
                
                const res2 = await fetch('http://127.0.0.1:3000/delete_msg', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message_id: commandMsgId })
                });
                const result2 = await res2.json();
                if (result2.status === 'ok') {
                    console.log('[撤回] ✅ 指令消息已撤回');
                } else {
                    console.log('[撤回] ❌ 指令消息撤回失败:', result2);
                }
            } catch (err) {
                console.log('[撤回] ❌ 指令消息撤回异常:', err.message);
            }
        } else {
            console.log('[撤回] ⚠️ 指令消息ID不存在，无法撤回');
        }
    }
};
