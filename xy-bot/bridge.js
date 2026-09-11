import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = 9520;
const ADAPTER_URL = 'http://127.0.0.1:9521';
const CONFIG_PATH = path.join(__dirname, '../temp/vris/vris.yaml');
const BRIDGE_SCRIPT = path.join(__dirname, 'bridge.py');
const HTTP_API_URL = 'http://127.0.0.1:3002';

// ========== 启动 bridge.py ==========
function startBridgePy() {
    console.log('[bridge.js] 启动 bridge.py ...');
    const py = spawn('python', [BRIDGE_SCRIPT], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
    });
    py.stdout.on('data', d => process.stdout.write(`[bridge.py] ${d}`));
    py.stderr.on('data', d => process.stderr.write(`[bridge.py] ${d}`));
    py.on('close', code => {
        console.log(`[bridge.js] bridge.py 退出, 代码: ${code}, 5秒后重启...`);
        setTimeout(startBridgePy, 5000);
    });
}

// ========== 读取配置 ==========
let _configCache = null;

function loadConfig() {
    if (_configCache) return _configCache;
    try {
        const safePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../temp/vris/vris.yaml');
        if (fs.existsSync(safePath)) {
            let raw = fs.readFileSync(safePath, 'utf8');
            raw = raw.replace(/^\uFEFF/, '');
            _configCache = YAML.parse(raw);
            return _configCache;
        }
    } catch (e) {
        console.error('[bridge.js] 读取配置失败:', e.message);
    }
    return null;
}

// ========== 查QQ昵称（调用3002端口） ==========
function getNickname(userId) {
    return new Promise(resolve => {
        const req = http.request(`${HTTP_API_URL}/get_stranger_info?user_id=${userId}`, { method: 'GET' }, res => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(raw);
                    // 3002端口返回格式: { status: "ok", data: { nickname: "xxx", ... } }
                    const nick = result?.data?.nickname || result?.nickname || null;
                    resolve(nick);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(3000, () => resolve(null));
        req.end();
    });
}

// ========== 模板渲染 ==========
function render(template, data) {
    // 模板里有 CQ 码 → 用 QQ号数字；没有 → 用昵称文字
    const qqValue = template.includes('[CQ:at') ? (data.user_id || '') : (data.nickname || data.user_id || '');
    return template
        .replace(/\{qq\}/g, qqValue)
        .replace(/\{operator\}/g, data.operator_id || '');
}

// ========== 启动 HTTP 接收服务 ==========
http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const noticeType = data.notice_type || '';

            if (noticeType !== 'group_increase' && noticeType !== 'group_decrease') {
                res.writeHead(200); res.end('{"status":"ok"}');
                return;
            }

            const config = loadConfig();
            const groupId = data.group_id;
            const userId = data.user_id;

            let template = null;
            if (noticeType === 'group_increase') {
                template = config?.welcome;
            } else if (noticeType === 'group_decrease') {
                template = data.sub_type === 'kick' ? config?.kick : config?.decrease;
            }

            if (template && groupId) {
                // 查昵称
                const nick = await getNickname(userId);
                data.nickname = nick;  // 塞进 data 里

                const msg = render(template, data);
                const fwdReq = http.request(
                    `${ADAPTER_URL}/send`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
                    fwdRes => {
                        console.log(`[bridge.js] ${fwdRes.statusCode === 200 ? '✅' : '❌'} 转发给adapter.js`);
                    }
                );
                fwdReq.on('error', e => console.error('[bridge.js] 转发失败:', e.message));
                fwdReq.write(JSON.stringify({ group_id: groupId, message: msg }));
                fwdReq.end();
            } else {
                console.log('[bridge.js] 无匹配模板，跳过');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"status":"ok"}');
        } catch (e) {
            console.error(`[bridge.js] 处理出错: ${e.message}`);
            res.writeHead(500); res.end('{"error":"internal"}');
        }
    });
}).listen(BRIDGE_PORT, () => {
    console.log(`[bridge.js] 🟢 监听端口: ${BRIDGE_PORT}`);
    startBridgePy();
});