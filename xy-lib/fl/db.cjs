// xy-lib/db.js
// ✅ 基于 better-sqlite3 的通用数据库模块

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ========================
// 获取调用方的 __dirname (精准定位到触发 db 的插件目录)
// ========================
function getCallerDir() {
  const err = new Error();
  const stack = err.stack || '';
  const lines = stack.split('\n');

  // 从第 3 行开始查找（跳过 Error 行、当前函数自身）
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i];
    
    // 忽略 Node 内部模块和 node_modules 中的堆栈
    if (line.includes('node:') || line.includes('internal/') || line.includes('node_modules')) {
      continue;
    }
    // 只忽略 db.js 自身，绝不忽略 index.js！
    if (line.includes('db.js')) {
      continue;
    }

    // 兼容 CJS 和 ESM 堆栈格式
    const match = line.match(/\(([^)]+):[0-9]+:[0-9]+\)/) || line.match(/at\s+(.+):[0-9]+:[0-9]+/);
    if (match) {
      let filePath = match[1];
      
      // 处理 ESM 环境的 file:// 协议 (新版 Node 常见)
      if (filePath.startsWith('file:///')) {
        try {
          filePath = require('url').fileURLToPath(filePath);
        } catch (e) {
          // 降级处理，兼容 Windows 路径
          filePath = filePath.replace(/^file:\/\/\//, '');
          if (filePath.startsWith('/') && /^[A-Za-z]:/.test(filePath.substring(1))) {
             filePath = filePath.substring(1); // 去掉盘符前的斜杠
          }
        }
      } else {
         filePath = filePath.replace(/^file:\/{3}/, '');
      }

      // 确保是绝对路径
      if (/^[A-Za-z]:/.test(filePath) || /^\//.test(filePath)) {
        // 返回调用该 db 的文件所在目录
        return path.dirname(filePath);
      }
    }
  }
  
  // 兜底策略：万一找不到调用方，强制使用项目根目录下的 xy-data
  const rootDir = path.resolve(__dirname, '..');
  const fallbackDir = path.join(rootDir, 'xy-data');
  if (!fs.existsSync(fallbackDir)) {
     fs.mkdirSync(fallbackDir, { recursive: true });
  }
  return fallbackDir;
}

// ========================
// 数据库连接缓存（避免重复打开）
// ========================
const dbCache = new Map();

function getDbInstance(dbPath) {
  if (dbCache.has(dbPath)) {
    return dbCache.get(dbPath);
  }
  // 确保目录存在
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const db = new Database(dbPath, { verbose: null });
  db.pragma('journal_mode = WAL'); // 性能优化
  dbCache.set(dbPath, db);
  return db;
}

function getDbPath(callerDir, dbName = 'data') {
  return path.join(callerDir, `${dbName}.db`);
}

// ========================
// 全局数据库函数
// ========================
globalThis.db = function (action, options = {}) {
  const callerDir = getCallerDir();
  const dbName = options.dbName || 'data';
  const dbPath = getDbPath(callerDir, dbName);

  switch (action) {
    // ---- 执行原生 SQL ----
    case 'exec': {
      const { sql, params = [] } = options;
      if (!sql) return { success: false, error: '参数错误: 缺少 sql' };
      try {
        const db = getDbInstance(dbPath);
        if (params.length > 0) {
          db.prepare(sql).run(...params);
        } else {
          db.exec(sql);
        }
        return { success: true, sql };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 插入数据 ----
    case 'insert': {
      const { table, data, columns } = options;
      if (!table) return { success: false, error: '参数错误: 缺少 table' };
      if (!data) return { success: false, error: '参数错误: 缺少 data' };

      try {
        const db = getDbInstance(dbPath);

        if (columns && Array.isArray(columns)) {
          const cols = columns.map(c => `"${c}"`).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          const stmt = db.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`);

          const insertData = Array.isArray(data[0]) ? data : [data];
          const insert = db.transaction((rows) => {
            for (const row of rows) stmt.run(...row);
          });
          insert(insertData);

          return { success: true, inserted: insertData.length };
        }

        const insertData = Array.isArray(data) ? data : [data];
        const firstRow = insertData[0];
        const cols = Object.keys(firstRow);
        const colStr = cols.map(c => `"${c}"`).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO "${table}" (${colStr}) VALUES (${placeholders})`);

        const insert = db.transaction((rows) => {
          for (const row of rows) {
            const values = cols.map(c => row[c]);
            stmt.run(...values);
          }
        });
        insert(insertData);

        return { success: true, inserted: insertData.length, table, lastID: db.prepare(`SELECT last_insert_rowid() as id`).get().id };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 查询数据 ----
    case 'find': {
      const { table, where = '', params = [], all = true } = options;
      if (!table) return { success: false, error: '参数错误: 缺少 table' };

      try {
        const db = getDbInstance(dbPath);
        let sql = `SELECT * FROM "${table}"`;
        if (where) sql += ` WHERE ${where}`;

        const stmt = db.prepare(sql);
        if (all) {
          const rows = stmt.all(...params);
          return { success: true, data: rows, count: rows.length };
        } else {
          const row = stmt.get(...params);
          return { success: true, data: row };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 更新数据 ----
    case 'update': {
      const { table, set, where = '', params = [] } = options;
      if (!table) return { success: false, error: '参数错误: 缺少 table' };
      if (!set) return { success: false, error: '参数错误: 缺少 set' };

      try {
        const db = getDbInstance(dbPath);
        let setClause = '';
        let allParams = [];

        if (typeof set === 'string') {
          setClause = set;
          allParams = params;
        } else {
          const keys = Object.keys(set);
          setClause = keys.map(k => `"${k}" = ?`).join(', ');
          allParams = [...Object.values(set), ...params];
        }

        let sql = `UPDATE "${table}" SET ${setClause}`;
        if (where) sql += ` WHERE ${where}`;

        const result = db.prepare(sql).run(...allParams);
        return { success: true, changes: result.changes };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 删除数据 ----
    case 'delete': {
      const { table, where = '', params = [] } = options;
      if (!table) return { success: false, error: '参数错误: 缺少 table' };

      try {
        const db = getDbInstance(dbPath);
        let sql = `DELETE FROM "${table}"`;
        if (where) sql += ` WHERE ${where}`;

        const result = db.prepare(sql).run(...params);
        return { success: true, deleted: result.changes };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 删除表 ----
    case 'drop': {
      const { table } = options;
      if (!table) return { success: false, error: '参数错误: 缺少 table' };

      try {
        const db = getDbInstance(dbPath);
        db.exec(`DROP TABLE IF EXISTS "${table}"`);
        return { success: true, message: `表 [${table}] 已删除` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 列出所有表 ----
    case 'tables': {
      try {
        const db = getDbInstance(dbPath);
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        return { success: true, data: rows.map(r => r.name) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 查看表结构 ----
    case 'schema': {
      const { table } = options;
      if (!table) return { success: false, error: '参数错误: 缺少 table' };

      try {
        const db = getDbInstance(dbPath);
        const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
        return { success: true, data: rows };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // ---- 关闭连接 ----
    case 'close': {
      try {
        const db = dbCache.get(dbPath);
        if (db) {
          db.close();
          dbCache.delete(dbPath);
        }
        return { success: true, message: `已关闭: ${dbPath}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    default:
      return { success: false, error: `未知操作: ${action}` };
  }
};