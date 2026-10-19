import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🌟 核心修复：因为文件在 xy-bot 里，我们要向上一级回到 XingYuanBot 根目录
const ROOT_DIR = path.join(__dirname, '../');

const app = express();
const PORT = 4000;
const PUBLIC_IP = '118.178.186.173'; // 🌟 你的公网 IP
let currentPort = 30100; 
let currentWebUI = 6100; 

app.use(express.json());
const instances = new Map();

app.get('/', (req, res) => {
    // 🌟 修复了模板字符串嵌套冲突的问题
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>云挂机平台</title>
        <style>
            body { font-family: sans-serif; background: #1e1e1e; color: #fff; padding: 20px; }
            .card { background: #333; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
            .btn { padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; }
            iframe { width: 100%; height: 600px; border: 1px solid #555; border-radius: 5px; margin-top: 15px; background: #fff; }
        </style>
    </head>
    <body>
        <h2>🚀 云挂机平台</h2>
        <div class="card">
            <h3>新建实例</h3>
            <button class="btn" onclick="createInstance()">启动并扫码登录</button>
            <p id="status" style="color: #aaa; margin-top: 10px;">点击按钮开始扫码...</p>
            <div id="qr-container"></div>
        </div>
        <script>
            async function createInstance() {
                document.getElementById('status').innerText = '正在启动协议端，请稍候...';
                const res = await fetch('/api/create', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('status').innerText = '请使用手机 QQ 扫码登录：';
                    document.getElementById('qr-container').innerHTML = 
                        '<iframe src="' + data.webuiUrl + '" width="100%" height="600px"></iframe>';
                    pollStatus(data.instanceId);
                } else {
                    document.getElementById('status').innerText = '启动失败: ' + data.msg;
                }
            }
            async function pollStatus(instanceId) {
                const timer = setInterval(async () => {
                    const res = await fetch('/api/status/' + instanceId);
                    const data = await res.json();
                    if (data.online) {
                        clearInterval(timer);
                        document.getElementById('status').innerText = '✅ 扫码成功，机器人已成功连入主控！';
                        document.getElementById('qr-container').innerHTML = 
                            '<div style="padding: 50px; text-align: center; color: #4CAF50; font-size: 20px;">🎉 代挂成功运行中</div>';
                    }
                }, 3000);
            }
        </script>
    </body>
    </html>
    `);
});

app.post('/api/create', async (req, res) => {
    try {
        const wsPort = currentPort++;
        const webuiPort = currentWebUI++;
        const instanceId = `user_${Date.now()}`;
        
        // 🌟 使用 ROOT_DIR 拼接路径，确保无论在哪执行都在根目录找 instances 和 template
        const userDir = path.join(ROOT_DIR, 'instances', instanceId);
        const templateDir = path.join(ROOT_DIR, 'napcat-template');

        if (!fs.existsSync(templateDir)) {
            return res.status(500).json({ success: false, msg: '根目录下缺少 napcat-template 文件夹，请先创建！' });
        }

        fs.copySync(templateDir, userDir);

        const child = spawn('node', ['app.js'], {
            cwd: userDir,
            env: {
                ...process.env,
                WS_PORT: wsPort.toString(),
                WEBUI_PORT: webuiPort.toString(),
                HOST: '0.0.0.0'
            },
            stdio: 'ignore'
        });

        instances.set(instanceId, { wsPort, webuiPort, child, online: false });

        res.json({ 
            success: true, 
            instanceId, 
            webuiUrl: `http://${PUBLIC_IP}:${webuiPort}` 
        });

        setTimeout(() => {
            fetch('http://127.0.0.1:3005/api/add_connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ws_url: `ws://127.0.0.1:${wsPort}` })
            }).then(() => {
                const inst = instances.get(instanceId);
                if (inst) inst.online = true;
            }).catch(console.error);
        }, 5000); 

    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.get('/api/status/:id', (req, res) => {
    const inst = instances.get(req.params.id);
    res.json({ online: inst ? inst.online : false });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 云挂机代理服务已启动: http://${PUBLIC_IP}:${PORT}`);
});