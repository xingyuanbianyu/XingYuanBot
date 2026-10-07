// xy-lib/log.js
// ✅ 通用日志模块 — 创建 / 写入 / 清除

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../', 'LOG');

// 确保 LOG 目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ========================
// 写入日志（追加模式）
// ========================
globalThis.writeLog = function (moduleName, content, ext = '.log') {
  if (!moduleName || typeof moduleName !== 'string') {
    globalThis.print(`⚠️ [writeLog] 模块名无效: ${moduleName}`);
    return;
  }

  const validExt = ext === '.txt' ? '.txt' : '.log';
  
  // 只用“日期”做文件名
  const today = globalThis.now().split(' ')[0];
  const fileName = `${moduleName}_${today}${validExt}`;
  const filePath = path.join(LOG_DIR, fileName);

  const timeStr = globalThis.now();
  const line = `[${timeStr}] [${moduleName}] ${content}\n`;

  try {
    fs.appendFileSync(filePath, line, 'utf8');
    return filePath;
  } catch (err) {
    globalThis.print(`❌ [writeLog] 写入失败: ${err.message}`);
    return null;
  }
};

// ========================
// 清除日志（支持通配符 * 与按天数保留）
// ========================
/**
 * @param {string} [moduleName] - 模块名。传 '*' 或为空表示清理所有模块。
 * @param {number|string} [keepDays] - 保留天数。不传或传 0 则清理所有时间段的日志。
 * @param {string} [ext]        - 限定后缀，如 '.log' 或 '.txt'
 */
globalThis.clearLog = function (moduleName, keepDays, ext) {
  if (!fs.existsSync(LOG_DIR)) return 0;

  // 🌟 1. 通配符判断
  const isWildcard = !moduleName || moduleName === '*';

  // 🌟 2. 天数解析（默认清理所有，即 0 天）
  let daysToKeep = 0; 
  if (keepDays !== undefined && keepDays !== null) {
    const numMatch = String(keepDays).match(/\d+/);
    if (numMatch) {
      daysToKeep = parseInt(numMatch[0], 10);
    }
  }

  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  const cutoffTime = now - (daysToKeep * msPerDay);

  const files = fs.readdirSync(LOG_DIR);
  let count = 0;

  for (const file of files) {
    // 🌟 3. 保护特殊文件（不管怎么清理，这俩都不能动！）
    if (file === '.gitkeep' || file === '.gitignore') continue;

    // 🌟 4. 模块名匹配：如果是通配符，全放行；否则必须匹配前缀
    if (!isWildcard && !file.startsWith(moduleName)) continue;

    // 后缀过滤
    if (ext && !file.endsWith(ext)) continue;

    const filePath = path.join(LOG_DIR, file);
    
    try {
      const stats = fs.statSync(filePath);
      // 🌟 5. 日期判断：只删除早于截止时间的文件
      if (stats.mtimeMs < cutoffTime) {
        fs.unlinkSync(filePath);
        count++;
      }
    } catch (err) {
      globalThis.print(`❌ [clearLog] 删除 ${file} 失败: ${err.message}`);
    }
  }

  const dayMsg = daysToKeep === 0 ? '全部时间段' : `超过 ${daysToKeep} 天的`;
  const moduleMsg = isWildcard ? '全部模块' : moduleName;
  globalThis.print(`🗑️ [clearLog] 已清除 ${count} 个日志文件（模块: ${moduleMsg}，保留: ${dayMsg}）`);
  return count;
};