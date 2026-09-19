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
    globalThis.print(`⚠️ [writeLog] 模块名无效: ${moduleName}`);
    return;
  }

  const validExt = ext === '.txt' ? '.txt' : '.log';
  const fileName = `${moduleName}_${globalThis.now().replace(/[: ]/g, '-')}${validExt}`;
  const filePath = path.join(LOG_DIR, fileName);

  const timeStr = globalThis.now();
  const line = `[${timeStr}] [${moduleName}] ${content}\n`;

  try {
    fs.appendFileSync(filePath, line, 'utf8');
    return filePath; // 返回写入路径，方便调试
  } catch (err) {
    globalThis.print(`❌ [writeLog] 写入失败: ${err.message}`);
    return null;
  }
};

// ========================
// 清除日志
// ========================
/**
 * @param {string} [moduleName] - 模块名，传则只清该模块；不传则清空全部
 * @param {string} [ext]        - 限定后缀，如 '.log' 或 '.txt'
 */
globalThis.clearLog = function (moduleName, ext) {
  if (!fs.existsSync(LOG_DIR)) return;

  const files = fs.readdirSync(LOG_DIR);
  let count = 0;

  for (const file of files) {
    if (file === '.gitkeep' || file === '.gitignore') continue;

    // 按模块名过滤
    if (moduleName && !file.startsWith(moduleName)) continue;
    // 按后缀过滤
    if (ext && !file.endsWith(ext)) continue;

    const filePath = path.join(LOG_DIR, file);
    try {
      fs.unlinkSync(filePath);
      count++;
    } catch (err) {
      globalThis.print(`❌ [clearLog] 删除 ${file} 失败: ${err.message}`);
    }
  }

  globalThis.print(`🗑️ [clearLog] 已清除 ${count} 个日志文件`);
  return count;
};

// ========================
// 加载提示
// ========================
globalThis.print("✅ [log.js] 日志模块已挂载 (writeLog / clearLog)");
