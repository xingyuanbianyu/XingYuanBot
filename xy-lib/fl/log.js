// xy-lib/log.js
// ✅ 通用日志模块 — 支持模块文件夹、多级路径、自动切分

const fs = require('fs');
const path = require('path');

(function () {
  "use strict";
  const VERSION = "1.2.0";
  const NS = "writeLog";

  if (globalThis[NS] && globalThis[NS].version === VERSION) {
    return;
  }

  // 根目录：以此文件向上两级找到 LOG 目录
  const LOG_DIR = path.join(__dirname, '../../', 'LOG');

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const _print = (msg) => {
    if (globalThis.print) globalThis.print(msg);
    else console.log(msg);
  };

  const _getNowStr = () => {
    if (globalThis.now) return globalThis.now();
    const pad = n => String(n).padStart(2, "0");
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // ✅ 安全清洗路径，允许多级目录（如 'system/db'），但阻止 .. 穿越
  const _safePath = (p) => {
    if (!p) return '';
    // 统一斜杠，移除非法字符，处理 ..
    return String(p)
      .replace(/\\/g, '/')
      .split('/')
      .map(seg => seg.replace(/[:\*?"<>|]/g, '_').replace(/\.\./g, '_').trim())
      .filter(seg => seg && seg !== '.')
      .join('/');
  };

  // ✅ 安全清洗单个文件名
  const _safeFileName = (name) => {
    if (!name) return '';
    return String(name).replace(/[\/\\:\*?"<>|]/g, '_').replace(/\.\./g, '_').trim();
  };

  // ========================
  // 1. 写入日志（追加模式）
  // ========================
  /**
   * @param {string} moduleName - 模块名或子目录路径（如 'bot' 或 'system/db'）
   * @param {string} [fileName] - 文件名（如 'error'），如果不传则默认以当天日期命名
   * @param {string} [ext='.log'] - 扩展名
   * @param {string} [content]  - 日志内容
   */
  function writeLog(moduleName, fileName, ext, content) {
    if (!moduleName || typeof moduleName !== 'string') {
      _print(`⚠️ [writeLog] 模块名无效: ${moduleName}`);
      return null;
    }

    // 🌟 智能参数兼容：如果只传了2个或3个参数（兼容旧版调用习惯）
    if (content === undefined && ext === undefined) {
      content = fileName;         // writeLog('bot', '日志内容')
      fileName = null;
      ext = '.log';
    } else if (content === undefined && typeof ext === 'string' && !ext.startsWith('.')) {
      content = ext;              // writeLog('bot', 'error', '日志内容')
      ext = '.log';
    }

    // 处理扩展名格式
    ext = ext || '.log';
    if (!ext.startsWith('.')) ext = '.' + ext;

    // 解析路径
    const safeDir = _safePath(moduleName);
    const dirPath = path.join(LOG_DIR, safeDir);
    
    // 自动创建对应的模块文件夹
    if (!fs.existsSync(dirPath)) {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
      } catch (err) {
        _print(`❌ [writeLog] 创建目录失败: ${err.message}`);
        return null;
      }
    }

    // 默认按天命名
    const today = _getNowStr().split(' ')[0];
    const finalName = fileName ? _safeFileName(fileName) : today;
    const filePath = path.join(dirPath, `${finalName}${ext}`);
    
    const timeStr = _getNowStr();
    const line = `[${timeStr}] [${moduleName}] ${content}\n`;

    try {
      fs.appendFileSync(filePath, line, 'utf8');
      return filePath;
    } catch (err) {
      _print(`❌ [writeLog] 写入失败: ${err.message}`);
      return null;
    }
  }

  // ========================
  // 2. 清除日志（支持按模块/目录递归清理）
  // ========================
  /**
   * @param {string} [moduleName] - 模块名或路径。传 '*' 或留空清理所有。
   * @param {number|string} [keepDays] - 保留天数。
   * @param {string} [ext] - 限定后缀。
   */
  function clearLog(moduleName, keepDays, ext) {
    if (!fs.existsSync(LOG_DIR)) return 0;

    const isWildcard = !moduleName || moduleName === '*';
    const safeDir = isWildcard ? '' : _safePath(moduleName);
    const targetDir = path.join(LOG_DIR, safeDir);

    if (!fs.existsSync(targetDir)) return 0;

    let daysToKeep = 0; 
    if (keepDays !== undefined && keepDays !== null) {
      const numMatch = String(keepDays).match(/\d+/);
      if (numMatch) daysToKeep = parseInt(numMatch[0], 10);
    }

    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const cutoffTime = now - (daysToKeep * msPerDay);

    let count = 0;

    // 🌟 递归清理目录
    function processDir(dir) {
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch (e) {
        return;
      }

      for (const file of files) {
        if (file === '.gitkeep' || file === '.gitignore' || file === 'Thumbs.db') continue;

        const filePath = path.join(dir, file);
        let stats;
        try {
          stats = fs.statSync(filePath);
        } catch (e) {
          continue;
        }

        if (stats.isDirectory()) {
          processDir(filePath); // 递归子目录
          // 如果子目录为空，顺便把空目录删掉
          try {
            if (fs.readdirSync(filePath).length === 0) fs.rmdirSync(filePath);
          } catch (e) {}
        } else {
          // 后缀过滤
          if (ext && !file.endsWith(ext)) continue;

          // 日期过滤
          if (daysToKeep > 0) {
            let fileDateMs = 0;
            const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
            
            if (dateMatch) {
              const parsedDate = new Date(`${dateMatch[1]}T23:59:59`).getTime();
              if (!Number.isNaN(parsedDate)) fileDateMs = parsedDate;
            }
            if (!fileDateMs) fileDateMs = stats.mtimeMs;

            if (fileDateMs >= cutoffTime) continue;
          }

          // 删除文件
          try {
            fs.unlinkSync(filePath);
            count++;
          } catch (err) {
            _print(`❌ [clearLog] 删除 ${file} 失败: ${err.message}`);
          }
        }
      }
    }

    processDir(targetDir);

    const dayMsg = daysToKeep === 0 ? '全部' : `超过 ${daysToKeep} 天的`;
    const moduleMsg = isWildcard ? '全部模块' : safeDir;
    _print(`🗑️ [clearLog] 已清除 ${count} 个日志文件（目录: ${moduleMsg}，保留: ${dayMsg}）`);
    
    return count;
  }

  writeLog.version = VERSION;
  globalThis[NS] = writeLog;
  globalThis.clearLog = clearLog;

  _print(`✅ [xy-lib] 日志模块已加载 (v${VERSION}) -> ${LOG_DIR}`);
})();