import express from 'express';
import fsExtra from 'fs-extra';
import { join } from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import fs from 'fs';
import QRCode from 'qrcode';

export function startWebPanel({ registry, plugins, handleIncomingMessage, sharedState, __dirname }) {
    const app = express();
    const PORT = 4000;
    const PUBLIC_IP = process.env.PUBLIC_IP || '127.0.0.1'; 
    const SECRET_TOKEN = process.env.PANEL_TOKEN || ''; 
    
    const ownerFilePath = join(__dirname, 'xy-data', 'owner.json');
    const PARENT_DIR = join(__dirname, '..');

    app.use(express.json());
    app.use(express.static(join(__dirname, 'views')));

    // ==================== 安全拦截：简单 Token 鉴权 ====================
    app.use((req, res, next) => {
        if (!SECRET_TOKEN) return next();
        const token = req.headers['x-panel-token'] || req.query.token;
        if (token === SECRET_TOKEN) return next();
        return res.status(401).json({ success: false, msg: 'Unauthorized: 缺少或错误的访问 Token' });
    });

    let baseWsPort = 30100;
    let baseWebUIPort = 6100;

    function getNextAvailablePort(startPort, isWebUI = false) {
        let port = startPort;
        while (true) {
            let isUsed = false;
            for (const inst of sharedState.instances.values()) {
                if (isWebUI ? inst.webuiPort === port : inst.wsPort === port) {
                    isUsed = true;
                    break;
                }
            }
            if (!isUsed) return port;
            port++;
        }
    }

    // 🌟 核心新增：扫描可用的协议端模板
    function scanAvailableProtocols() {
        const protocols = [];
        try {
            const files = fs.readdirSync(PARENT_DIR);
            for (const file of files) {
                const fullPath = join(PARENT_DIR, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    // 匹配以 -template 结尾的目录，或者特定的已知名字
                    if (file.endsWith('-template') || ['napcat', 'Napcat', 'llonebot', 'LLOneBot'].includes(file)) {
                        const name = file.replace('-template', '');
                        // 生成友好名称，避免大小写混乱
                        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
                        protocols.push({ id: file, name: displayName });
                    }
                }
            }
        } catch (e) {
            globalThis.print(`⚠️ [面板] 扫描协议端失败: ${e.message}`);
        }
        return protocols;
    }

    app.get('/', (req, res) => {
        res.sendFile(join(__dirname, 'views', 'dashboard.html'));
    });

    // 🌟 新增接口：供前端获取已安装的协议端列表
    app.get('/api/protocols', (req, res) => {
        const protocols = scanAvailableProtocols();
        res.json({ success: true, protocols });
    });

    app.get('/api/state', (req, res) => {
        const instanceList = [];
        for (const [id, inst] of sharedState.instances) {
            let hasQr = !!inst.qrUrl;
            
            if (!hasQr) {
                const possiblePaths = [
                    join(inst.userDir, 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'cache', 'qrcode.png'),
                    join(inst.userDir, 'cache', 'qrcode.png')
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
                hasQr: hasQr,
                exitCode: inst.exitCode,
                protocol: inst.protocol || '未知协议端' // 记录启动用的什么端
            });
        }
        res.json({ ownerQQ: sharedState.ownerQQ, instances: instanceList });
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

    app.get('/api/logs/:id', (req, res) => {
        const inst = sharedState.instances.get(req.params.id);
        if (!inst) return res.status(404).send('实例不存在或已被销毁');
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send((inst.logs || []).join('\n'));
    });

    // 🌟 核心修改：/api/create 支持接收 protocol 参数
    app.post('/api/create', async (req, res) => {
        const { mode, qq, password, protocol } = req.body;
        
        if (!protocol) return res.status(400).json({ success: false, msg: '请先选择协议端' });

        try {
            const wsPort = getNextAvailablePort(baseWsPort, false);
            const webuiPort = getNextAvailablePort(baseWebUIPort, true);
            baseWsPort = wsPort + 1;
            baseWebUIPort = webuiPort + 1;

            const instanceId = `bot_${Date.now()}`;
            const userDir = join(__dirname, 'instances', instanceId);

            // 🌟 动态匹配模板目录
            const TEMPLATE_DIR = join(PARENT_DIR, protocol);
            if (!fsExtra.existsSync(TEMPLATE_DIR)) {
                return res.status(500).json({ success: false, msg: `找不到协议端模板目录: ${protocol}` });
            }
            
            fsExtra.copySync(TEMPLATE_DIR, userDir);

            const pidFile = join(userDir, 'napcat.pid');
            if (fsExtra.existsSync(pidFile)) fsExtra.removeSync(pidFile);
            const cacheDir = join(userDir, 'data', 'nt_qq');
            if (fsExtra.existsSync(cacheDir)) fsExtra.emptyDirSync(cacheDir);

            // 🌟 动态适配配置文件 (只要有就改，没有就跳过，兼容不同协议端)
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

            globalThis.print(`🚀 [面板] 正在拉起实例 ${instanceId} (协议端: ${protocol}, 模式: ${mode})`);
            
            // 🌟 智能寻找启动脚本
            let spawnCmd = 'bash';
            let spawnArgs = [];
            const possibleShells = ['napcat.sh', 'llob.sh', 'start.sh', 'run.sh', 'start.bat'];
            const possibleExecs = ['napcat', 'llonebot', 'main', 'app'];
            let foundLaunchFile = false;

            for (const sh of possibleShells) {
                if (fsExtra.existsSync(join(userDir, sh))) { spawnArgs = [sh]; foundLaunchFile = true; break; }
            }
            if (!foundLaunchFile) {
                for (const exe of possibleExecs) {
                    if (fsExtra.existsSync(join(userDir, exe))) { spawnCmd = `./${exe}`; spawnArgs = []; foundLaunchFile = true; break; }
                }
            }
            if (!foundLaunchFile) {
                 return res.status(500).json({ success: false, msg: `目录中缺失启动脚本 (尝试过 .sh 和常见可执行文件)。` });
            }

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

            const instanceObj = { 
                wsPort, 
                webuiPort, 
                child, 
                online: false, 
                userDir, 
                mode, 
                protocol, // 记录协议端
                qrUrl: null, 
                logs: [] 
            };
            sharedState.instances.set(instanceId, instanceObj);

            const pushLog = (text) => {
                const inst = sharedState.instances.get(instanceId);
                if (!inst) return;
                const lines = text.toString().split('\n').filter(l => l.trim());
                for (const line of lines) {
                    inst.logs.push(line);
                    if (inst.logs.length > 300) inst.logs.shift();
                }
            };

            let capturedQrUrl = null;
            child.stdout.on('data', (data) => {
                const str = data.toString();
                pushLog(str);
                // 兼容多协议端的二维码正则
                const match = str.match(/(?:二维码解码URL|二维码链接|qrcode)[:：]\s*(https?:\/\/[^\s]+)/i);
                if (match && !capturedQrUrl) {
                    capturedQrUrl = match[1];
                    const inst = sharedState.instances.get(instanceId);
                    if (inst) inst.qrUrl = capturedQrUrl;
                    globalThis.print(`✅ [面板] 成功从日志截获二维码解析URL!`);
                }
                process.stdout.write(str); 
            });

            child.stderr.on('data', (data) => {
                pushLog(data.toString());
                process.stderr.write(data.toString());
            });

            child.on('exit', (code) => {
                globalThis.print(`⚠️ [面板] 实例 ${instanceId} 退出，退出码: ${code}`);
                const inst = sharedState.instances.get(instanceId);
                if (inst) {
                    inst.online = false;
                    inst.exitCode = code;
                }
            });

            res.json({ success: true, instanceId });

            const connectInstanceWS = (retries = 0) => {
                if (retries > 10 || !sharedState.instances.has(instanceId)) return;
                
                const newWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
                
                newWs.on('open', () => {
                    const inst = sharedState.instances.get(instanceId);
                    if (inst) inst.online = true;
                    globalThis.print(`✅ [面板] 实例 ${instanceId} 动态接入成功`);
                });
                
                newWs.on('message', (msg) => handleIncomingMessage(msg.toString(), newWs, registry, plugins));
                
                newWs.on('error', () => {
                    if (sharedState.instances.has(instanceId)) {
                        setTimeout(() => connectInstanceWS(retries + 1), 3000);
                    }
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

    app.get('/api/qrcode/:id', async (req, res) => {
        const inst = sharedState.instances.get(req.params.id);
        if (!inst) return res.status(404).send('Not found');

        if (inst.qrUrl) {
            try {
                res.set('Content-Type', 'image/png');
                const qrBuffer = await QRCode.toBuffer(inst.qrUrl, { width: 300 });
                return res.send(qrBuffer);
            } catch (e) {
                globalThis.print(`⚠️ [面板] 本地生成二维码失败: ${e.message}`);
            }
        }

        const possiblePaths = [
            join(inst.userDir, 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'cache', 'qrcode.png'),
            join(inst.userDir, 'cache', 'qrcode.png')
        ];

        for (const qrPath of possiblePaths) {
            if (fsExtra.existsSync(qrPath)) {
                res.set('Cache-Control', 'no-store');
                return res.sendFile(qrPath);
            }
        }
        
        res.status(404).send('QR Code not ready yet');
    });

    const server = app.listen(PORT, '0.0.0.0', () => {
        globalThis.print(`🚀 网页面板已启动: http://${PUBLIC_IP}:${PORT}`);
    });

    server.on('close', () => {
        globalThis.print('🛑 [面板] 正在关闭，清理所有实例...');
        for (const [id, inst] of sharedState.instances) {
            if (inst.child && !inst.child.killed) {
                inst.child.kill('SIGKILL');
            }
        }
    });

    return server;
}