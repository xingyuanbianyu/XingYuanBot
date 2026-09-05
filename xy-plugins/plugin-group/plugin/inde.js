class WelcomePlugin {
    constructor(pluginConfig) {
        this.pluginConfig = pluginConfig;
        this.apiBase = 'http://127.0.0.1:3000';
    }

    async handle(data) {
      const noticeType = data.msg?.notice_type || data.notice_type;
      const groupId = data.msg?.group_id || data.group_id;
      const userId = data.msg?.user_id || data.user_id;
      const operatorId = data.msg?.operator_id || data.operator_id;

      // 入群
     if (noticeType === 'group_increase') {
       const msg = `[CQ:at,qq=${userId}] 欢迎新人入群！🎉`;
       await this._sendMsg(groupId, msg);
       return null;
      }

      // 退群
      if (noticeType === 'group_decrease') {
          const msg = `💀 有人退群了（QQ: ${userId}）`;
         await this._sendMsg(groupId, msg);
         return null;
      }

      return null;
    }

    async _sendMsg(groupId, message) {
        try {
            await fetch(`${this.apiBase}/send_group_msg`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    group_id: groupId,
                    message: message,
                    auto_escape: false
                })
            });
        } catch (err) {
            console.error('[welcome-plugin] 发送消息失败:', err.message);
        }
    }
}

export default WelcomePlugin;
