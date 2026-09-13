export default {
    name: "群管工具箱",
    description: "支持 #撤回、#群待办、#取消待办",

    // 统一匹配三个命令
    match: function (text, msg) {
        let txt = "";
        if (typeof text === "string") txt = text;
        else if (Array.isArray(text)) {
            for (let s of text) {
                if (s && s.type === "text") txt += (s.data && s.data.text ? s.data.text : "");
            }
        }
        // 匹配 #撤回、#群待办、#取消待办
        return /#撤回|#群待办|#取消待办/i.test(txt);
    },

    handle: async function (msg, matchResult) {
        let text = msg.text || "";
        const chatId = msg.chatId || msg.group_id;
        const commandMsgId = msg.msg?.message_id; // 指令消息本身的ID

        // 提取引用ID
        let m = text.match(/\[引用ID:(-?\d+)\]/);
        let refId = m ? parseInt(m[1]) : null;

        // 判断具体命令
        const isRecall = text.includes('#撤回');
        const isTodo = text.includes('#群待办');
        const isCancel = text.includes('#取消待办');

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            console.log('[撤回] 开始执行');
            if (!m) {
                console.log('[撤回] 未找到引用ID');
                return;
            }

            // 1.1 撤回被引用的消息
            try {
                const res1 = await fetch('http://127.0.0.1:3000/delete_msg', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message_id: refId })
                });
                const result1 = await res1.json();
                if (result1.status === 'ok') console.log('[撤回] ✅ 目标消息已撤回');
                else console.log('[撤回] ❌ 目标消息撤回失败:', result1);
            } catch (err) {
                console.log('[撤回] ❌ 目标消息撤回异常:', err.message);
            }

            // 1.2 撤回指令消息本身
            if (commandMsgId) {
                try {
                    await new Promise(r => setTimeout(r, 300)); // 延迟防太快
                    const res2 = await fetch('http://127.0.0.1:3000/delete_msg', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message_id: commandMsgId })
                    });
                    const result2 = await res2.json();
                    if (result2.status === 'ok') console.log('[撤回] ✅ 指令消息已撤回');
                } catch (err) {
                    console.log('[撤回] ❌ 指令消息撤回异常:', err.message);
                }
            }
            return; // 执行完撤回直接结束，不往下走
        }

        // ================= 权限检查函数 (待办功能共用) =================
        async function checkBotPermission() {
            try {
                // 获取 Bot QQ 号
                const botRes = await fetch('http://127.0.0.1:3000/get_login_info');
                const botData = await botRes.json();
                const botQQ = botData?.data?.user_id;
                if (!botQQ) return '❌ 无法获取 Bot 账号信息';

                // 获取群成员信息
                const infoRes = await fetch(`http://127.0.0.1:3000/get_group_member_info?group_id=${chatId}&user_id=${botQQ}&no_cache=true`);
                const info = await infoRes.json();
                const role = info?.data?.role;
                if (role !== 'owner' && role !== 'admin') {
                    return '❌ Bot权限不足：请先将 Bot 设为群管理员或群主';
                }
                return true; // 权限通过
            } catch (e) {
                return `❌ 权限校验异常：${e.message}`;
            }
        }

        // ================= 2. 群待办逻辑 =================
        if (isTodo) {
            console.log('[群待办] 开始执行');
            if (!m) return '⚠️ 用法：请回复一条消息，再发送 #群待办';

            const checkResult = await checkBotPermission();
            if (checkResult !== true) return checkResult;

            try {
                const res = await fetch('http://127.0.0.1:3000/set_group_todo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        group_id: Number(chatId),
                        message_id: refId
                    })
                });
                const result = await res.json();
                if (result.status === 'ok') {
                    return `✅ 已成功将引用的消息设为群待办 (ID: ${refId})`;
                } else {
                    return `❌ 设置失败：${result.message || result.msg}`;
                }
            } catch (e) {
                return `❌ 设置异常：${e.message}`;
            }
        }

        // ================= 3. 取消待办逻辑 =================
        if (isCancel) {
            console.log('[取消待办] 开始执行');
            
            const checkResult = await checkBotPermission();
            if (checkResult !== true) return checkResult;

            try {
                // 获取待办列表
                const listRes = await fetch(`http://127.0.0.1:3000/get_group_todo_list?group_id=${chatId}`);
                const listData = await listRes.json();

                if (listData.status !== 'ok' || !listData.data || listData.data.length === 0) {
                    return '✅ 当前群内没有需要取消的待办。';
                }

                let successCount = 0;
                let failCount = 0;

                // 遍历取消
                for (const todo of listData.data) {
                    const messageId = todo.message_id;
                    if (!messageId) continue;

                    try {
                        const cancelRes = await fetch('http://127.0.0.1:3000/cancel_group_todo', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                group_id: Number(chatId),
                                message_id: Number(messageId)
                            })
                        });
                        const cancelData = await cancelRes.json();
                        if (cancelData.status === 'ok') successCount++;
                        else failCount++;
                    } catch (e) {
                        failCount++;
                    }
                }

                return `✅ 取消待办完成。成功：${successCount}个，失败/已过期：${failCount}个。`;

            } catch (e) {
                return `❌ 取消操作异常：${e.message}`;
            }
        }
    }
};