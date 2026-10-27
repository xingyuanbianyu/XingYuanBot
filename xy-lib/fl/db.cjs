// xy-lib/db.js
// ✅ 基于 better-sqlite3 的全局数据库模块

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

(function () {
  "use strict";

  const VERSION = "1.0.0";
  const NS = "xyDb"; // 全局命名空间兜底

  // ---------- 幂等：重复加载直接跳过 ----------
  if (globalThis.db && globalThis.db.version === VERSION) {
    return;
  }

  // ========================
  // 获取调用方的 __dirname (仅作为兜底)
  // ========================
  function getCallerDir() {
    const err = new Error();
    const stack = err.stack || '';
    const lines = stack.split('\n');

    for (let i = 3; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('db.js') || line.includes('node:internal')) continue;

      const match = line.match(/\(([^)]+):[0-9]+:[0-9]+\)/) || line.match(/at\s+(.+):[0-9]+:[0-9]+/);
      
      if (match) {
        let filePath = match[1];
        if (filePath.startsWith('file://')) {
          try {
            filePath = fileURLToPath(filePath);
          } catch (e) {
            filePath = filePath.replace(/^file:\/{3}/, '');
          }
        }
        if (/^[A-Za-z]:/.test(filePath) || /^\//.test(filePath)) {
          return path.dirname(filePath);
        }
      }
    }
    console.warn('⚠️ [DB警告] 无法解析插件路径，将使用当前工作目录 (process.cwd())');
    return process.cwd();
  }

  // ========================
  // 数据库连接缓存
  // ========================
  const dbCache = new Map();

  function getDbInstance(dbPath) {
    if (dbCache.has(dbPath)) {
      return dbCache.get(dbPath);
    }
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const db = new Database(dbPath, { verbose: null });
    db.pragma('journal_mode = WAL'); // 读写不打架
    db.pragma('busy_timeout = 3000'); // ✅ 防止并发写锁死（等待 3 秒）
    dbCache.set(dbPath, db);
    return db;
  }

  function getDbPath(callerDir, dbName = 'data') {
    return path.join(callerDir, `${dbName}.db`);
  }

  // ✅ 简单的表名/字段名安全校验（防注入）
  function isValidIdentifier(name) {
    return /^[a-zA-Z0-9_]+$/.test(name);
  }

  // ========================
  // 核心 DB 函数
  // ========================
  const dbFn = function (action, options = {}) {
    let dbPath = options.dbPath;

    if (!dbPath) {
      const callerDir = getCallerDir();
      const dbName = options.dbName || 'data';
      dbPath = getDbPath(callerDir, dbName);
    } else {
      if (!path.isAbsolute(dbPath)) {
        // ✅ 优化路径解析：优先基于 process.cwd()，而不是写死 __dirname
        dbPath = path.resolve(process.cwd(), dbPath);
      }
    }

    try {
      switch (action) {
        // ---- 执行原生 SQL ----
        case 'exec': {
          const { sql, params = [] } = options;
          if (!sql) return { success: false, error: '参数错误: 缺少 sql' };
          const db = getDbInstance(dbPath);
          if (params.length > 0) {
            const info = db.prepare(sql).run(...params);
            return { success: true, changes: info.changes, lastInsertRowid: info.lastInsertRowid };
          } else {
            db.exec(sql);
            return { success: true };
          }
        }

        // ---- 插入数据 ----
        case 'insert': {
          const { table, data, columns } = options;
          if (!table || !data) return { success: false, error: '参数错误: 缺少 table 或 data' };
          
          const db = getDbInstance(dbPath);
          const insertData = Array.isArray(data) ? data : [data];
          
          // ✅ 修复：空数组直接返回
          if (insertData.length === 0) return { success: true, inserted: 0 };

          let stmt;
          let executeFn;

          // 方案 A：提供了显式的 columns（数组形式传入）
          if (columns && Array.isArray(columns)) {
            if (!columns.every(isValidIdentifier)) return { success: false, error: '非法列名' };
            const cols = columns.map(c => `"${c}"`).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            stmt = db.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`);
            executeFn = (row) => stmt.run(...row);
          } 
          // 方案 B：对象形式（根据第一行提取列名）
          else {
            const firstRow = insertData[0];
            const cols = Object.keys(firstRow);
            if (!cols.every(isValidIdentifier)) return { success: false, error: '非法列名' };
            
            const colStr = cols.map(c => `"${c}"`).join(', ');
            const placeholders = cols.map(() => '?').join(', ');
            stmt = db.prepare(`INSERT INTO "${table}" (${colStr}) VALUES (${placeholders})`);
            
            // ✅ 修复：防止某些行缺失字段导致 undefined 报错
            executeFn = (row) => {
              const values = cols.map(c => row[c] === undefined ? null : row[c]);
              return stmt.run(...values);
            };
          }

          // 开启事务批量插入
          const insertTx = db.transaction((rows) => {
            let lastId = null;
            for (const row of rows) {
              const info = executeFn(row);
              if (info && info.lastInsertRowid) lastId = info.lastInsertRowid;
            }
            return lastId;
          });

          const lastID = insertTx(insertData);
          return { success: true, inserted: insertData.length, lastID };

        }

        // ---- 查询数据 ----
        case 'find': {
          const { table, where = '', params = [], all = true } = options;
          if (!table) return { success: false, error: '参数错误: 缺少 table' };
          
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
        }

        // ---- 更新数据 ----
        case 'update': {
          const { table, set, where = '', params = [] } = options;
          if (!table || !set) return { success: false, error: '参数错误: 缺少 table 或 set' };

          const db = getDbInstance(dbPath);
          let setClause = '';
          let allParams = [];

          if (typeof set === 'string') {
            setClause = set;
            allParams = params;
          } else {
            const keys = Object.keys(set);
            if (!keys.every(isValidIdentifier)) return { success: false, error: '非法列名' };
            setClause = keys.map(k => `"${k}" = ?`).join(', ');
            allParams = [...Object.values(set), ...params];
          }

          let sql = `UPDATE "${table}" SET ${setClause}`;
          if (where) sql += ` WHERE ${where}`;

          const result = db.prepare(sql).run(...allParams);
          return { success: true, changes: result.changes };
        }

        // ---- 删除数据 ----
        case 'delete': {
          const { table, where = '', params = [] } = options;
          if (!table) return { success: false, error: '参数错误: 缺少 table' };

          const db = getDbInstance(dbPath);
          let sql = `DELETE FROM "${table}"`;
          if (where) sql += ` WHERE ${where}`;

          const result = db.prepare(sql).run(...params);
          return { success: true, deleted: result.changes };
        }

        // ---- 删除表 ----
        case 'drop': {
          const { table } = options;
          if (!table) return { success: false, error: '参数错误: 缺少 table' };

          const db = getDbInstance(dbPath);
          db.exec(`DROP TABLE IF EXISTS "${table}"`);
          return { success: true, message: `表 [${table}] 已删除` };
        }

        // ---- 列出所有表 ----
        case 'tables': {
          const db = getDbInstance(dbPath);
          const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
          return { success: true, data: rows.map(r => r.name) };
        }

        // ---- 查看表结构 ----
        case 'schema': {
          const { table } = options;
          if (!table) return { success: false, error: '参数错误: 缺少 table' };

          const db = getDbInstance(dbPath);
          const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
          return { success: true, data: rows };
        }

        // ---- 关闭连接 ----
        case 'close': {
          const db = dbCache.get(dbPath);
          if (db) {
            db.close();
            dbCache.delete(dbPath);
            return { success: true, message: `已关闭: ${dbPath}` };
          }
          return { success: true, message: `连接未打开，无需关闭` };
        }

        default:
          return { success: false, error: `未知操作: ${action}` };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  // 挂载版本信息
  dbFn.version = VERSION;

  // 双挂兜底
  globalThis[NS] = dbFn;
  globalThis.db = dbFn;

  // ✅ 进程退出时自动清理缓存，避免残留 WAL 文件
  const closeAllDbs = () => {
    for (const [p, db] of dbCache.entries()) {
      try { db.close(); } catch (e) {}
    }
    dbCache.clear();
  };
  process.once('beforeExit', closeAllDbs);
  process.once('SIGINT', () => { closeAllDbs(); process.exit(0); });

  console.log(`✅ [xy-lib] DB 模块已加载 (v${VERSION})`);
})();