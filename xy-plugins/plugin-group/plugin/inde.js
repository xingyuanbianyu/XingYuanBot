import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'vris.yaml');

class WelcomePlugin {
    constructor(pluginConfig) {
        this.pluginConfig = pluginConfig;
        this.apiBase = 'http://127.0.0.1:3001';
        this.selfId = null;
        this.config = this._loadConfig();
        this._initSelfId();
    }

    // 启动时获取机器人自己的 QQ 号，用于过滤自身事件
    async _initSelfId() {
        try {
            const res = await axios.get(`${this.apiBase}/get_login_info`);
            if (res.data.status === 'ok') {
                this.selfId = String(res.data.data.user_id);
                console.log(`[vris] 机器人QQ: ${this.selfId}`);
            }
        } catch (e) {
            console.error('[vris] 获取机器人QQ号失败:', e.message);
        }
    }

    _loadConfig() {
        try {
            const yamlStr = fs.readFileSync(CONFIG_PATH, 'utf-8');
            return YAML.parse(yamlStr);
        } catch (e) {
            console.error('[vris] 配置文件读取失败，使用默认文案', e.message);
            return {
                welcome: '[CQ:at,qq={qq}] 欢迎新人入群！🎉',
                decrease: '💀 有人退群了（QQ: {qq}）',
                kick: '💀 有人退群了（QQ: {qq}） (被 {operator} 请出去了)'
            };
        }
    }

    match(data) {
        const noticeType = data.msg?.notice_type || data.notice_type;
        return noticeType === 'group_increase' || noticeType === 'group_decrease';
    }

    handle(data) {
        const noticeType = data.msg?.notice_type || data.notice_type;
        const userId = String(data.msg?.user_id || data.user_id || '');

        // 如果是机器人自己被拉进来/被踢出去，直接忽略
        if (this.selfId && userId === this.selfId) {
            console.log(`[vris] 检测到机器人自身事件(${noticeType})，跳过`);
            return null;
        }

        const operatorId = String(data.msg?.operator_id || data.operator_id || '');

        if (noticeType === 'group_increase') {
            let msg = this.config.welcome || '';
            return msg.replace('{qq}', userId);
        }

        if (noticeType === 'group_decrease') {
            // operatorId 存在且不等于 userId，说明是被踢的
            if (operatorId && operatorId !== userId) {
                let msg = this.config.kick || '';
                return msg.replace('{qq}', userId).replace('{operator}', operatorId);
            } else {
                let msg = this.config.decrease || '';
                return msg.replace('{qq}', userId);
            }
        }

        return null;
    }
}

export default WelcomePlugin;
