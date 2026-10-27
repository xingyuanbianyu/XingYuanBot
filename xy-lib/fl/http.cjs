// ========================
// 全局 HTTP 请求
// ========================
(function () {
  "use strict";
  const VERSION = "1.1.0";
  const NS = "httpRequest";

  // 防止重复加载
  if (globalThis[NS] && globalThis[NS].version === VERSION) {
    return;
  }

  const http = require('http');
  const https = require('https');
  const zlib = require('zlib');

  function httpRequest(options = {}) {
    return new Promise((resolve) => {
      // 处理递归重定向
      function doRequest(currentUrl, redirectCount = 0) {
        if (!options || typeof options !== 'object') {
          return resolve({ status: -1, data: null, error: '❌ 参数错误: options 必须是一个对象' });
        }

        let rawUrl = currentUrl || options.url;
        if (!rawUrl || typeof rawUrl !== 'string') {
          return resolve({ status: -1, data: null, error: '❌ 参数错误: url 不能为空且必须是字符串' });
        }

        // ---- 1. URL 解析 ----
        let parsedUrl;
        try {
          if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'http://' + rawUrl;
          parsedUrl = new URL(rawUrl);
        } catch (e) {
          return resolve({ status: -1, data: null, error: `❌ 参数错误: url 格式非法 -> ${rawUrl}` });
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const port = options.port || parsedUrl.port || (isHttps ? 443 : 80);
        const method = (options.method || 'GET').toUpperCase();
        
        // 🌟 修复：合并 path 和原有的 search，除非 options.path 显式包含 '?'
        let reqPath = options.path || parsedUrl.pathname;
        if (!reqPath.startsWith('/')) reqPath = '/' + reqPath;
        if (parsedUrl.search && !reqPath.includes('?')) {
          reqPath += parsedUrl.search;
        }

        const timeout = options.timeout || 10000;

        // ---- 2. 请求头组装 ----
        const headers = {
          'User-Agent': 'XingYuanBot/1.0',
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br', // 🌟 修复：声明支持压缩
          ...options.headers,
        };

        // ---- 3. 请求体处理 ----
        let bodyData = null;
        if (options.data !== undefined && method !== 'GET') {
          const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
          const userContentType = hasContentType 
            ? headers[Object.keys(headers).find(k => k.toLowerCase() === 'content-type')].toLowerCase() 
            : '';

          if (Buffer.isBuffer(options.data) || options.data instanceof Uint8Array) {
            bodyData = options.data;
            if (!hasContentType) headers['Content-Type'] = 'application/octet-stream';
          } else if (typeof options.data === 'object') {
            // 🌟 修复：尊重用户的 Content-Type
            if (hasContentType && userContentType.includes('application/x-www-form-urlencoded')) {
              bodyData = new URLSearchParams(options.data).toString();
            } else {
              bodyData = JSON.stringify(options.data);
              if (!hasContentType) headers['Content-Type'] = 'application/json';
            }
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

        let isSettled = false;

        const req = client.request(reqOptions, (res) => {
          // 🌟 修复：处理重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectCount >= 5) {
              if (!isSettled) { isSettled = true; resolve({ status: -1, data: null, error: '❌ 重定向次数过多 (超过 5 次)' }); }
              return req.destroy();
            }
            const redirectUrl = new URL(res.headers.location, parsedUrl.href).href;
            req.destroy();
            return doRequest(redirectUrl, redirectCount + 1);
          }

          let chunks = [];
          let decompressor;

          // 🌟 修复：处理解压，防止乱码
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();
          if (encoding === 'gzip') decompressor = zlib.createGunzip();
          else if (encoding === 'deflate') decompressor = zlib.createInflate();
          else if (encoding === 'br') decompressor = zlib.createBrotliDecompress();

          const stream = decompressor ? res.pipe(decompressor) : res;

          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            if (isSettled) return;
            isSettled = true;
            
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed = raw;

            if (options.json !== false) {
              const trimmed = raw.trim();
              if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try { parsed = JSON.parse(raw); } catch (e) { /* 忽略解析错误 */ }
              }
            }
            resolve({ status: res.statusCode, data: parsed });
          });

          stream.on('error', (err) => {
            if (isSettled) return;
            isSettled = true;
            resolve({ status: -1, data: null, error: `❌ 解压/数据流读取失败: ${err.message}` });
          });
        });

        // ---- 5. 错误与超时处理 ----
        req.on('error', (err) => {
          if (isSettled) return;
          isSettled = true;
          
          let errMsg = `❌ 请求失败 [${method} ${parsedUrl.hostname}:${port}${reqPath}]`;
          if (err.code === 'ECONNREFUSED') errMsg += ' → 连接被拒绝（检查地址/端口是否正确、服务是否启动）';
          else if (err.code === 'ENOTFOUND') errMsg += ' → 域名解析失败（检查地址是否写错）';
          else if (err.code === 'ETIMEDOUT') errMsg += ' → 请求超时（检查网络或服务响应）';
          else if (err.code === 'ECONNRESET') errMsg += ' → 连接被重置（服务可能崩溃）';
          else errMsg += ` → ${err.message}`;
          
          resolve({ status: -1, data: null, error: errMsg });
        });

        req.on('timeout', () => {
          if (isSettled) return;
          isSettled = true;
          req.destroy(); // destroy 会触发 error 事件，但已被 isSettled 拦截
          resolve({ status: -2, data: null, error: `❌ 请求超时 [${timeout}ms] 未收到响应` });
        });

        if (bodyData) req.write(bodyData);
        req.end();
      }

      doRequest(options.url);
    });
  }

  httpRequest.version = VERSION;
  globalThis[NS] = httpRequest;

  // 快捷请求
  globalThis.httpGet = function (url, options = {}) {
    return httpRequest({ url, method: 'GET', ...options });
  };

  globalThis.httpPost = function (url, data, options = {}) {
    return httpRequest({ url, method: 'POST', data, ...options });
  };

  console.log(`✅ [xy-lib] HTTP 模块已加载 (v${VERSION})`);
})();