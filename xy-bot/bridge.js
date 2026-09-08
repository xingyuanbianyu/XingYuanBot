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
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('[bridge.js] 读取配置失败:', e.message);
    }
    return null;
}

// ========== 模板渲染 ==========
function render(template, data) {
    return template
        .replace(/\{qq\}/g, data.user_id || '')
        .replace(/\{operator\}/g, data.operator_id || '');
}

// ========== 启动 HTTP 接收服务（收 bridge.py 的转发） ==========
http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
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
    startBridgePy();  // 端口就绪后拉起 Python
});
