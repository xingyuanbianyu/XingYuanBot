// xy-lib/db.js
// ✅ 基于 better-sqlite3 的通用数据库模块

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ========================
// 获取调用方的 __dirname
// ========================
function getCallerDir() {
  const err = new Error();
  const stack = err.stack || '';
  const lines = stack.split('\n');

  for (let i = 3; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('db.js') || line.includes('index.js')) continue;
    const match = line.match(/\(([^)]+):[0-9]+:[0-9]+\)/) || line.match(/at\s+(.+):[0-9]+:[0-9]+/);
    if (match) {
      let filePath = match[1].replace(/^file:\/{3}/, '');
      if (/^[A-Za-z]:/.test(filePath) || /^\//.test(filePath)) {
        return path.dirname(filePath);
      }
    }
  }
  return process.cwd();
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
/**
 * @param {string} action  - 操作类型
 * @param {Object} options - 操作参数
 * @returns {Object}       - 操作结果
 *
 * action:
 *   'exec'    - 执行原生 SQL（适合建表、复杂查询）
 *   'insert'  - 插入数据（单条/批量）
 *   'find'    - 查询数据
 *   'update'  - 更新数据
 *   'delete'  - 删除数据
 *   'drop'    - 删表
 *   'tables'  - 列出所有表
 *   'schema'  - 查看表结构
 *   'close'   - 关闭数据库连接
 */
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

        // 如果传了 columns，用指定字段插入
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

        // 自动从对象提取字段
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

        // set 可以是字符串或对象
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

globalThis.print?.("✅ [db.js] SQLite 数据库模块已挂载 (db)");
 