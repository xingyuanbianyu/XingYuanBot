const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// 统一日志
const log = (msg) => (globalThis.print || console.log)(msg);
const logErr = (msg) => (globalThis.print || console.error)(msg);

// 1. 定位到 xy-bot 的上一级目录下的 xy-lib
const targetDir = path.resolve(__dirname, '../xy-lib');

// 兼容 字符串 / 数组，过滤非法项
function normalizeEntries(entries) {
    if (!entries) return [];
    if (typeof entries === 'string') return [entries.trim()].filter(Boolean);
    if (Array.isArray(entries)) return entries.filter(e => typeof e === 'string' && e.trim());
    return [];
}

// 统一 ESM 加载
async function importEntry(entryPath, bustCache) {
    // 🌟 注意：带时间戳的 ESM 动态导入无法被 GC 回收，请勿在极短时间内极其频繁地调用
    const url = pathToFileURL(entryPath).href + (bustCache ? '?t=' + Date.now() : '');
    await import(url);
}

// 统一 CJS 加载：彻底清除该目录下所有模块的缓存
function requireEntry(entryPath, bustCache, folderPath) {
    if (bustCache) {
        // 🌟 核心修复 1：不仅删除入口文件，还要删除该模块目录下所有的 CJS 缓存
        const normalizedFolder = folderPath + path.sep;
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(normalizedFolder)) {
                delete require.cache[key];
            }
        }
    }
    require(entryPath);
}

async function loadAllModules({ cacheBust = false } = {}) {
    if (!fs.existsSync(targetDir)) {
        log(`⚠️ [xy-lib] 目录不存在，跳过加载: ${targetDir}`);
        return { successCount: 0, failCount: 0 };
    }

    // 2. 扫描 targetDir
    const folders = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    // 🌟 核心修复 2：支持通过 lib.json 的 priority 字段控制加载顺序
    const sortedFolders = [];
    for (const folder of folders) {
        const ruleFile = path.join(targetDir, folder, 'lib.json');
        let priority = 999; // 默认优先级
        if (fs.existsSync(ruleFile)) {
            try {
                const rule = JSON.parse(fs.readFileSync(ruleFile, 'utf8'));
                if (typeof rule.priority === 'number') {
                    priority = rule.priority;
                }
            } catch (e) {}
        }
        sortedFolders.push({ folder, priority });
    }
    // 按优先级排序，数字越小越先加载
    sortedFolders.sort((a, b) => a.priority - b.priority);

    let successCount = 0;
    let failCount = 0;

    for (const { folder } of sortedFolders) {
        const folderPath = path.join(targetDir, folder);
        const ruleFile = path.join(folderPath, 'lib.json');

        if (!fs.existsSync(ruleFile)) {
            log(`⏭️  [xy-lib] 忽略目录 (无 lib.json): ${folder}`);
            continue;
        }

        let rule;
        try {
            rule = JSON.parse(fs.readFileSync(ruleFile, 'utf8'));
        } catch (e) {
            logErr(`❌ [xy-lib] 解析 ${folder}/lib.json 失败: ${e.message}`);
            failCount++;
            continue;
        }

        if (rule.enable === false) {
            log(`⏸️  [xy-lib] 跳过未启用模块: ${folder}`);
            continue;
        }

        // 读取模块的 package.json（可选）
        const pkgFile = path.join(folderPath, 'package.json');
        let moduleType = null;

        if (fs.existsSync(pkgFile)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
                if (pkg.type) moduleType = pkg.type;
            } catch (e) {
                logErr(`⚠️  [xy-lib] ${folder}/package.json 解析失败，忽略 type 字段`);
            }
        }

        const entries = normalizeEntries(rule.entries);
        if (entries.length === 0) {
            log(`⏭️  [xy-lib] ${folder} 无有效 entries，跳过`);
            continue;
        }

        // 加载入口文件
        for (const entry of entries) {
            const entryPath = path.resolve(folderPath, entry);

            // 🌟 核心修复 3：路径安全校验，防止 lib.json 里的 entry 乱指路径
            if (!entryPath.startsWith(folderPath + path.sep) && entryPath !== folderPath) {
                logErr(`⚠️  [xy-lib] 安全拦截：${folder}/lib.json 中的 entry 越界：${entry}`);
                continue;
            }

            const ext = path.extname(entry).toLowerCase();

            if (!fs.existsSync(entryPath)) {
                logErr(`⚠️  [xy-lib] 找不到文件: ${folder}/${entry}`);
                failCount++;
                continue;
            }

            try {
                if (ext === '.mjs') {
                    await importEntry(entryPath, cacheBust);
                    log(`✅ [xy-lib] [import] ${folder}/${entry}`);
                } else if (ext === '.cjs') {
                    requireEntry(entryPath, cacheBust, folderPath);
                    log(`✅ [xy-lib] [require] ${folder}/${entry}`);
                } else {
                    if (moduleType === 'module') {
                        await importEntry(entryPath, cacheBust);
                        log(`✅ [xy-lib] [import] ${folder}/${entry} (type=module)`);
                    } else {
                        requireEntry(entryPath, cacheBust, folderPath);
                        log(`✅ [xy-lib] [require] ${folder}/${entry}`);
                    }
                }
                successCount++;
            } catch (e) {
                logErr(`❌ [xy-lib] 加载 ${folder}/${entry} 失败: ${e.message}`);
                failCount++;
            }
        }
    }

    log(`📊 [xy-lib] 扫描完成，共注册 ${successCount} 个，失败 ${failCount} 个。`);
    return { successCount, failCount };
}

module.exports = loadAllModules;
module.exports.loadAllModules = loadAllModules;