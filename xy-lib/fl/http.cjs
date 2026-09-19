// ========================
// 全局 HTTP 请求
// ========================
/**
 * @param {Object} options - 请求配置
 * @param {string} options.url       - 目标地址（如 "127.0.0.1" 或 "http://api.example.com"）
 * @param {number} [options.port]    - 端口号（默认根据协议自动判断 80/443）
 * @param {string} [options.path='/']- API 路径
 * @param {string} [options.method='GET'] - 请求方法
 * @param {Object|string} [options.data] - 请求体数据（对象自动 JSON.stringify）
 * @param {Object} [options.headers] - 额外请求头
 * @param {number} [options.timeout=10000] - 超时时间（ms）
 * @param {boolean} [options.json=true] - 是否自动解析 JSON 响应
 * @returns {Promise<{ status: number, data: any, error?: string }>}
 */
globalThis.httpRequest = function (options = {}) {
  return new Promise(async (resolve) => {
    const http = require('http');
    const https = require('https');

    // ---- 1. 参数校验 ----
    if (!options || typeof options !== 'object') {
      return resolve({ status: -1, data: null, error: '❌ 参数错误: options 必须是一个对象' });
    }

    let rawUrl = options.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
      return resolve({ status: -1, data: null, error: '❌ 参数错误: url 不能为空且必须是字符串' });
    }

    // ---- 2. URL 解析 ----
    let parsedUrl;
    try {
      // 如果没有协议头，自动补 http://
      if (!/^https?:\/\//i.test(rawUrl)) {
        rawUrl = 'http://' + rawUrl;
      }
      parsedUrl = new URL(rawUrl);
    } catch (e) {
      return resolve({ status: -1, data: null, error: `❌ 参数错误: url 格式非法 -> ${rawUrl}` });
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const port = options.port || parsedUrl.port || (isHttps ? 443 : 80);
    const method = (options.method || 'GET').toUpperCase();
    const reqPath = options.path || parsedUrl.pathname + parsedUrl.search;
    const timeout = options.timeout || 10000;

    // ---- 3. 请求头组装 ----
    const headers = {
      'User-Agent': 'XingYuanBot/1.0',
      'Accept': '*/*',
      ...options.headers,
    };

    let bodyData = null;
    if (options.data !== undefined && method !== 'GET') {
      if (typeof options.data === 'object') {
        bodyData = JSON.stringify(options.data);
        headers['Content-Type'] = 'application/json';
      } else {
        bodyData = String(options.data);
      }
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    // ---- 4. 发起请求 ----
    const reqOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: port,
      path: reqPath,
      method: method,
      headers: headers,
      timeout: timeout,
    };

    const req = client.request(reqOptions, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        if (options.json !== false && raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
          try { parsed = JSON.parse(raw); } catch (e) { /* 不是 JSON，保持原样 */ }
        }
        resolve({ status: res.statusCode, data: parsed });
      });
    });

    // ---- 5. 错误处理 ----
    req.on('error', (err) => {
      // 区分"连接失败"和"参数问题"
      let errMsg = `❌ 请求失败 [${method} ${parsedUrl.hostname}:${port}${reqPath}]`;
      if (err.code === 'ECONNREFUSED') {
        errMsg += ' → 连接被拒绝（检查地址/端口是否正确、服务是否启动）';
      } else if (err.code === 'ENOTFOUND') {
        errMsg += ' → 域名解析失败（检查地址是否写错）';
      } else if (err.code === 'ETIMEDOUT') {
        errMsg += ' → 请求超时（检查网络或服务响应）';
      } else if (err.code === 'ECONNRESET') {
        errMsg += ' → 连接被重置（服务可能崩溃）';
      } else {
        errMsg += ` → ${err.message}`;
      }
      resolve({ status: -1, data: null, error: errMsg });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: -2, data: null, error: `❌ 请求超时 [${timeout}ms] 未收到响应` });
    });

    // ---- 6. 发送数据 ----
    if (bodyData) req.write(bodyData);
    req.end();
  });
};

// ========================
// 简写版（GET 快捷请求）
// ========================
globalThis.httpGet = function (url, options = {}) {
  return globalThis.httpRequest({ url, method: 'GET', ...options });
};

// ========================
// 简写版（POST 快捷请求）
// ========================
globalThis.httpPost = function (url, data, options = {}) {
  return globalThis.httpRequest({ url, method: 'POST', data, ...options });
};

globalThis.print("✅ [httpRequest] HTTP 请求模块已挂载 (httpRequest / httpGet / httpPost)");
