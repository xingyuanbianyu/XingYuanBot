import express from 'express';
import fsExtra from 'fs-extra';
import { join } from 'path';
import { spawn, execSync } from 'child_process';
import { WebSocket } from 'ws';
import fs from 'fs';

export function startWebPanel({ registry, plugins, handleIncomingMessage, sharedState, __dirname }) {
    const app = express();
    const PORT = 4000;
    const PUBLIC_IP = process.env.PUBLIC_IP || '127.0.0.1'; 
    const ownerFilePath = join(__dirname, 'xy-data', 'owner.json');
    
    let currentWsPort = 30100; 
    let currentWebUI = 6100; 

    const PARENT_DIR = join(__dirname, '..');
    let TEMPLATE_DIR = join(PARENT_DIR, 'napcat-template');
    if (!fsExtra.existsSync(TEMPLATE_DIR)) {
        TEMPLATE_DIR = join(PARENT_DIR, 'Napcat');
    }

    app.use(express.json());
    app.use(express.static(join(__dirname, 'views'))); 

    app.get('/', (req, res) => {
        res.sendFile(join(__dirname, 'views', 'dashboard.html'));
    });

    // 🌟 核心：状态接口，判断是否有二维码
    app.get('/api/state', (req, res) => {
        const instanceList = [];
        for (const [id, inst] of sharedState.instances) {
            let hasQr = false;
            if (inst.qrUrl) {
                hasQr = true;
            } else {
                const possiblePaths = [
                    join(inst.userDir, 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'cache', 'qrcode.png'),
                    join(inst.userDir, 'cache', 'qrcode.png'),
                    join(__dirname, 'napcat-template', 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'cache', 'qrcode.png'),
                    '/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png',
                    '/root/Napcat/cache/qrcode.png',
                    '/root/XingYuanBot/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png'
                ];
                for (const p of possiblePaths) {
                    if (fsExtra.existsSync(p)) { hasQr = true; break; }
                }
            }

            instanceList.push({ 
                id, 
                online: inst.online, 
                wsPort: inst.wsPort,
                mode: inst.mode || 'qr',
                hasQr: hasQr
            });
        }
        res.json({ 
            ownerQQ: sharedState.ownerQQ,
            instances: instanceList
        });
    });

    app.post('/api/set-owner', (req, res) => {
        const { ownerQQ } = req.body;
        if (!ownerQQ) return res.status(400).json({ success: false, msg: 'QQ号不能为空' });
        sharedState.ownerQQ = String(ownerQQ);
        fs.writeFileSync(ownerFilePath, JSON.stringify({ ownerQQ: sharedState.ownerQQ, updateAt: Date.now() }, null, 2));
        res.json({ success: true });
    });

    app.post('/api/stop/:id', (req, res) => {
        const inst = sharedState.instances.get(req.params.id);
        if (!inst) return res.status(404).json({ success: false, msg: '实例不存在' });
        try {
            if (inst.child && !inst.child.killed) {
                inst.child.kill('SIGKILL'); 
            }
            sharedState.instances.delete(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, msg: e.message });
        }
    });

    app.post('/api/create', async (req, res) => {
        const { mode, qq, password } = req.body;
        try {
            const wsPort = currentWsPort++;
            const webuiPort = currentWebUI++;
            const instanceId = `bot_${Date.now()}`;
            const userDir = join(__dirname, 'instances', instanceId);

            if (!fsExtra.existsSync(TEMPLATE_DIR)) return res.status(500).json({ success: false, msg: `找不到协议端模板` });
            
            fsExtra.copySync(TEMPLATE_DIR, userDir);

            const pidFile = join(userDir, 'napcat.pid');
            if (fsExtra.existsSync(pidFile)) fsExtra.removeSync(pidFile);
            const cacheDir = join(userDir, 'data', 'nt_qq');
            if (fsExtra.existsSync(cacheDir)) fsExtra.emptyDirSync(cacheDir);

            const webuiConfigPath = join(userDir, 'config', 'webui.json');
            if (fsExtra.existsSync(webuiConfigPath)) {
                const webuiConfig = fsExtra.readJsonSync(webuiConfigPath);
                webuiConfig.port = webuiPort;
                webuiConfig.host = '0.0.0.0'; 
                fsExtra.writeJsonSync(webuiConfigPath, webuiConfig);
            }

            const onebotConfigPath = join(userDir, 'config', 'onebot11.json');
            if (fsExtra.existsSync(onebotConfigPath)) {
                 const obConfig = fsExtra.readJsonSync(onebotConfigPath);
                 if (obConfig.network && obConfig.network.websocketServers && obConfig.network.websocketServers.length > 0) {
                     obConfig.network.websocketServers[0].port = wsPort;
                 }
                 fsExtra.writeJsonSync(onebotConfigPath, obConfig);
            }

            globalThis.print(`🚀 [面板] 正在拉起实例 ${instanceId} (模式: ${mode})`);
            
            let spawnCmd = 'bash';
            let spawnArgs = [];
            
            if (fsExtra.existsSync(join(userDir, 'napcat.sh'))) spawnArgs = ['napcat.sh'];
            else if (fsExtra.existsSync(join(userDir, 'start.sh'))) spawnArgs = ['start.sh'];
            else if (fsExtra.existsSync(join(userDir, 'run.sh'))) spawnArgs = ['run.sh'];
            else if (fsExtra.existsSync(join(userDir, 'napcat'))) spawnCmd = './napcat';
            else return res.status(500).json({ success: false, msg: `目录中缺失启动脚本。` });

            const envVars = { 
                ...process.env, 
                HOME: userDir, 
                XDG_CONFIG_HOME: join(userDir, '.config'),
                NAPCAT_WEBUI_PORT: webuiPort.toString(),
                NAPCAT_WS_PORT: wsPort.toString()
            };

            if (mode === 'password' && qq && password) {
                envVars.ACCOUNT = qq;
                envVars.PASSWORD = password;
                envVars.NAPCAT_ACCOUNT = qq;
                envVars.NAPCAT_PASSWORD = password;
            }

            const child = spawn(spawnCmd, spawnArgs, {
                cwd: userDir,
                env: envVars,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let capturedQrUrl = null;
            child.stdout.on('data', (data) => {
                const str = data.toString();
                const match = str.match(/(?:二维码解码URL|二维码链接)[:：]\s*(https?:\/\/[^\s]+)/);
                if (match && !capturedQrUrl) {
                    capturedQrUrl = match[1];
                    const inst = sharedState.instances.get(instanceId);
                    if (inst) inst.qrUrl = capturedQrUrl;
                    globalThis.print(`✅ [面板] 成功从日志截获二维码解析URL!`);
                }
                process.stdout.write(str); 
            });

            child.stderr.on('data', (data) => process.stderr.write(data.toString()));

            child.on('exit', (code) => {
                globalThis.print(`⚠️ [面板] 实例 ${instanceId} 退出，退出码: ${code}`);
                sharedState.instances.delete(instanceId);
            });

            sharedState.instances.set(instanceId, { wsPort, webuiPort, child, online: false, userDir, mode, qrUrl: null });
            res.json({ success: true, instanceId });

            const connectInstanceWS = (retries = 0) => {
                if (retries > 10) return;
                const newWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
                
                newWs.on('open', () => {
                    const inst = sharedState.instances.get(instanceId);
                    if (inst) inst.online = true;
                    globalThis.print(`✅ [面板] 实例 ${instanceId} 动态接入成功`);
                });
                
                newWs.on('message', (msg) => handleIncomingMessage(msg.toString(), newWs, registry, plugins));
                
                newWs.on('error', () => {
                    if (retries < 10) setTimeout(() => connectInstanceWS(retries + 1), 3000);
                });
                
                newWs.on('close', () => {
                    sharedState.wsPool.delete(newWs);
                    const botId = sharedState.wsToBotId.get(newWs);
                    if (botId) {
                        sharedState.botIdToWs.delete(botId);
                        sharedState.wsToBotId.delete(newWs);
                    }
                });
            };

            setTimeout(() => connectInstanceWS(0), 10000); 

        } catch (e) {
            res.status(500).json({ success: false, msg: e.message });
        }
    });

    // 🌟 终极防万一：多路并发寻找二维码
    app.get('/api/qrcode/:id', async (req, res) => {
        const inst = sharedState.instances.get(req.params.id);
        if (!inst) return res.status(404).send('Not found');

        if (inst.qrUrl) {
            try {
                const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(inst.qrUrl)}`;
                const response = await fetch(qrApiUrl);
                const buffer = await response.arrayBuffer();
                res.set('Content-Type', 'image/png');
                return res.send(Buffer.from(buffer));
            } catch (e) {}
        }

        const possiblePaths = [
            join(inst.userDir, 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'cache', 'qrcode.png'),
            join(inst.userDir, 'cache', 'qrcode.png'),
            join(__dirname, 'napcat-template', 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'cache', 'qrcode.png'),
            '/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png',
            '/root/Napcat/cache/qrcode.png',
            '/root/XingYuanBot/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png'
        ];

        for (const qrPath of possiblePaths) {
            if (fsExtra.existsSync(qrPath)) {
                res.set('Cache-Control', 'no-store');
                return res.sendFile(qrPath);
            }
        }

        try {
            const findResult = execSync(`find /root -name "qrcode.png" -type f 2>/dev/null | head -n 1`).toString().trim();
            if (findResult && fsExtra.existsSync(findResult)) {
                res.set('Cache-Control', 'no-store');
                return res.sendFile(findResult);
            }
        } catch (e) {}

        res.status(404).send('QR Code not ready yet');
    });

    app.listen(PORT, '0.0.0.0', () => {
        globalThis.print(`🚀 网页面板已启动: http://${PUBLIC_IP}:${PORT}`);
    });
}