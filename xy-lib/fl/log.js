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
/**
 * @param {string} moduleName - 模块名（用于文件名和日志前缀）
 * @param {string} content    - 日志内容
 * @param {string} [ext='.log'] - 后缀名，支持 '.log' 或 '.txt'
 */
globalThis.writeLog = function (moduleName, content, ext = '.log') {
  if (!moduleName || typeof moduleName !== 'string') {
    if (globalThis.print) globalThis.print(`⚠️ [writeLog] 模块名无效: ${moduleName}`);
    return;
  }

  const validExt = ext === '.txt' ? '.txt' : '.log';
  
  // 🌟 核心修复 1：只提取日期部分 (YYYY-MM-DD)，彻底告别一秒一个文件！
  const today = globalThis.now().split(' ')[0]; 
  const fileName = `${moduleName}_${today}${validExt}`;
  const filePath = path.join(LOG_DIR, fileName);

  const timeStr = globalThis.now();
  const line = `[${timeStr}] [${moduleName}] ${content}\n`;

  try {
    // 🌟 如果涉及高并发且日志极大，未来可改为 fs.appendFile 异步写入，目前同步写入保证顺序不乱
    fs.appendFileSync(filePath, line, 'utf8');
    return filePath; // 返回写入路径，方便调试
  } catch (err) {
    if (globalThis.print) globalThis.print(`❌ [writeLog] 写入失败: ${err.message}`);
    return null;
  }
};

// ========================
// 清除日志（支持按天数保留、通配符）
// ========================
/**
 * @param {string} [moduleName] - 模块名。传 '*' 或为空表示清理所有模块。
 * @param {number|string} [keepDays] - 保留天数。不传或传 0 则清理所有时间段的日志。支持 "7", "7天"
 * @param {string} [ext]        - 限定后缀，如 '.log' 或 '.txt'
 */
globalThis.clearLog = function (moduleName, keepDays, ext) {
  if (!fs.existsSync(LOG_DIR)) return 0;

  // 1. 通配符判断
  const isWildcard = !moduleName || moduleName === '*';

  // 2. 天数解析（默认清理所有，即 0 天）
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

  let files = [];
  try {
    files = fs.readdirSync(LOG_DIR);
  } catch (e) {
    return 0;
  }

  let count = 0;

  for (const file of files) {
    // 3. 保护特殊文件
    if (file === '.gitkeep' || file === '.gitignore') continue;

    // 4. 模块名过滤（通配符直接放行，否则按前缀匹配）
    if (!isWildcard && !file.startsWith(moduleName)) continue;
    
    // 5. 后缀过滤
    if (ext && !file.endsWith(ext)) continue;

    const filePath = path.join(LOG_DIR, file);
    
    try {
      // 6. 日期判断：如果设定的保留天数 > 0，则只删早于截止时间的文件
      if (daysToKeep > 0) {
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs >= cutoffTime) {
          continue; // 还没过期，保留
        }
      }
      
      // 7. 删除
      fs.unlinkSync(filePath);
      count++;
    } catch (err) {
      if (globalThis.print) globalThis.print(`❌ [clearLog] 删除 ${file} 失败: ${err.message}`);
    }
  }

  if (globalThis.print) {
    const dayMsg = daysToKeep === 0 ? '全部' : `超过 ${daysToKeep} 天的`;
    const moduleMsg = isWildcard ? '全部模块' : moduleName;
    globalThis.print(`🗑️ [clearLog] 已清除 ${count} 个日志文件（模块: ${moduleMsg}，保留: ${dayMsg}）`);
  }
  
  return count;
};