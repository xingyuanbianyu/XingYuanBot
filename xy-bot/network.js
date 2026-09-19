import WebSocket, { WebSocketServer } from 'ws';
import fs from 'fs';
import { join } from 'path';
import yaml from 'yaml';

export function loadNetworkConfig(dataDir) {
  const configs = [];
  const serverPath = join(dataDir, 'bot_server.yaml');
  const clientPath = join(dataDir, 'bot_client.yaml');

  // 读取 Server 配置
  if (fs.existsSync(serverPath)) {
    const parsed = yaml.parse(fs.readFileSync(serverPath, 'utf8'));
    const serverCfg = parsed.server || parsed; // 兼容嵌套和平铺
    if (serverCfg.port) {
      configs.push({ role: 'server', ...serverCfg });
    } else {
      print(`⚠ bot_server.yaml 中未找到 port 字段`);
    }
  }

  // 读取 Client 配置
  if (fs.existsSync(clientPath)) {
    const parsed = yaml.parse(fs.readFileSync(clientPath, 'utf8'));
    const clientCfg = parsed.client || parsed; // 兼容嵌套和平铺
    
    if (clientCfg.url) {
      // 写法1：直接写了 url
      configs.push({ role: 'client', ...clientCfg });
    } else if (clientCfg.host && clientCfg.port) {
      // 写法2：写了 host 和 port（就是你图里这种）
      configs.push({ 
        role: 'client', 
        ...clientCfg,
        url: `ws://${clientCfg.host}:${clientCfg.port}` // 自动拼接 ws://
      });
    } else {
      print(`⚠ bot_client.yaml 中未找到 url 或 host+port 字段`);
    }
  }

  return configs;
}

export function startNetwork(configs, onMessage, onError) {
  let activeMode = null;
  let serverInstance = null;
  let serverWs = null; 
  let clientWs = null; 

  const serverConfig = configs.find(c => c.role === 'server');
  const clientConfig = configs.find(c => c.role === 'client');

  const setActive = (mode) => {
    if (activeMode === mode) return;
    print(`\n🔄 [网络切换] 激活模式: ${mode === 'server' ? '服务端监听' : '客户端主动连接'}`);
    activeMode = mode;

    if (mode === 'server' && clientWs) {
      print(`👉 触发竞争：关闭客户端主动连接模式...`);
      clientWs.close();
      clientWs = null;
    } else if (mode === 'client' && serverWs) {
      print(`👉 触发竞争：断开服务端当前接入的连接...`);
      serverWs.close();
      serverWs = null;
    }
  };

  // 1. 初始化服务端（Server）监听
  if (serverConfig) {
    serverInstance = new WebSocketServer({ port: serverConfig.port });
    
    serverInstance.on('connection', (ws) => {
      print(`✅ [网络] 服务端成功接入连接 (端口 ${serverConfig.port})`);
      setActive('server');
      serverWs = ws;

      ws.on('message', (data) => onMessage(data.toString(), ws));
      ws.on('error', onError);
      
      ws.on('close', () => {
        print(`⚠ [网络] 服务端连接已断开`);
        serverWs = null;
        if (activeMode === 'server') {
          activeMode = null;
          startClientReconnect();
        }
      });
    });
    print(`👂 [网络] 服务端监听已启动，端口: ${serverConfig.port}`);
  }

  // 2. 初始化客户端（Client）连接逻辑
  const connectClient = () => {
    if (activeMode === 'server' || !clientConfig) return;
    
    print(`🔗 [网络] 正在连接服务端: ${clientConfig.url}...`);
    clientWs = new WebSocket(clientConfig.url);

    clientWs.on('open', () => {
      print(`✅ [网络] 客户端成功连接到服务端`);
      setActive('client');
    });

    clientWs.on('message', (data) => onMessage(data.toString(), clientWs));
    clientWs.on('error', onError);

    clientWs.on('close', () => {
      print(`⚠ [网络] 客户端连接已断开`);
      clientWs = null;
      if (activeMode === 'client') {
        activeMode = null;
      }
    });
  };

  const startClientReconnect = () => {
    if (clientConfig && !clientWs && activeMode !== 'server') {
      setTimeout(() => {
        if (!clientWs && activeMode !== 'server') connectClient();
      }, 3000);
    }
  };

  if (clientConfig) {
    connectClient();
  }

  return [
    serverInstance ? { role: 'server', ws: () => serverWs } : null,
    clientConfig ? { role: 'client', ws: () => clientWs } : null
  ].filter(Boolean);
}
