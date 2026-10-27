// lib.cjs
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const log = (msg) => (globalThis.print || console.log)(msg);
const logErr = (msg) => (globalThis.print || console.error)(msg);

// 1. 定位到上一级目录下的 xy-lib
const targetDir = path.resolve(__dirname, '../xy-lib');

// 并发锁：防止同时触发两次热重载导致状态混乱
let isLoading = false;

// 兼容 字符串 / 数组，过滤非法项
function normalizeEntries(entries) {
    if (!entries) return [];
    if (typeof entries === 'string') return [entries.trim()].filter(Boolean);
    if (Array.isArray(entries)) return entries.filter(e => typeof e === 'string' && e.trim());
    return [];
}

// 统一 ESM 加载
async function importEntry(entryPath, bustCache) {
    // ⚠️ 警告：带时间戳的 ESM 动态导入无法被 GC 回收。
    // 所以仅在明确要求 bustCache 且是开发环境时才使用，生产环境避免频繁热重载 ESM 库。
    const url = pathToFileURL(entryPath).href + (bustCache ? '?t=' + Date.now() : '');
    await import(url);
}

// 统一 CJS 加载：递归清理该模块及其依赖的所有缓存
function requireEntry(entryPath, bustCache) {
    if (bustCache) {
        // ✅ 修复：增加 visited Set，防止循环依赖导致爆栈死循环
        const visited = new Set();
        function clearCache(modulePath) {
            if (visited.has(modulePath)) return;
            visited.add(modulePath);

            const cached = require.cache[modulePath];
            if (!cached) return;
            
            if (cached.children) {
                cached.children.forEach(child => {
                    // 排除 node_modules，避免清掉底层的第三方库
                    if (!child.filename.includes('node_modules')) {
                        clearCache(child.filename);
                    }
                });
            }
            delete require.cache[modulePath];
        }
        clearCache(require.resolve(entryPath));
    }
    require(entryPath);
}

async function loadAllModules({ cacheBust = false } = {}) {
    if (isLoading) {
        log('⚠️ [xy-lib] 正在加载中，忽略本次重复调用...');
        return { successCount: 0, failCount: 0 };
    }

    if (!fs.existsSync(targetDir)) {
        log(`⚠️ [xy-lib] 目录不存在，跳过加载: ${targetDir}`);
        return { successCount: 0, failCount: 0 };
    }

    isLoading = true;
    let successCount = 0;
    let failCount = 0;

    try {
        // 2. 扫描 targetDir
        const folders = fs.readdirSync(targetDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        const folderGroups = new Map(); // 按优先级分组：Map<priority, folder[]>

        for (const folder of folders) {
            const ruleFile = path.join(targetDir, folder, 'lib.json');
            let priority = 999;
            if (fs.existsSync(ruleFile)) {
                try {
                    const rule = JSON.parse(fs.readFileSync(ruleFile, 'utf8'));
                    if (typeof rule.priority === 'number') priority = rule.priority;
                } catch (e) {}
            }
            if (!folderGroups.has(priority)) folderGroups.set(priority, []);
            folderGroups.get(priority).push(folder);
        }

        // 按优先级从小到大排序
        const sortedPriorities = Array.from(folderGroups.keys()).sort((a, b) => a - b);

        // 3. 开始按优先级加载
        for (const priority of sortedPriorities) {
            const currentFolders = folderGroups.get(priority);
            
            // 🌟 优化：同一优先级的模块【并发加载】，大幅提升启动速度
            const promises = currentFolders.map(async (folder) => {
                const folderPath = path.join(targetDir, folder);
                const ruleFile = path.join(folderPath, 'lib.json');

                if (!fs.existsSync(ruleFile)) {
                    log(`⏭️  [xy-lib] 忽略目录 (无 lib.json): ${folder}`);
                    return;
                }

                let rule;
                try {
                    rule = JSON.parse(fs.readFileSync(ruleFile, 'utf8'));
                } catch (e) {
                    logErr(`❌ [xy-lib] 解析 ${folder}/lib.json 失败: ${e.message}`);
                    failCount++;
                    return;
                }

                if (rule.enable === false) {
                    log(`⏸️  [xy-lib] 跳过未启用模块: ${folder}`);
                    return;
                }

                const pkgFile = path.join(folderPath, 'package.json');
                let moduleType = null;
                if (fs.existsSync(pkgFile)) {
                    try {
                        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
                        if (pkg.type) moduleType = pkg.type;
                    } catch (e) {}
                }

                const entries = normalizeEntries(rule.entries);
                if (entries.length === 0) {
                    log(`⏭️  [xy-lib] ${folder} 无有效 entries，跳过`);
                    return;
                }

                // 内部的 entries 依然保持串行，防止库内部文件之间相互依赖的问题
                for (const entry of entries) {
                    const entryPath = path.resolve(folderPath, entry);
                    const relativePath = path.relative(folderPath, entryPath);
                    
                    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                        logErr(`⚠️  [xy-lib] 安全拦截：${folder}/lib.json 中的 entry 越界：${entry}`);
                        continue;
                    }

                    if (!fs.existsSync(entryPath)) {
                        logErr(`⚠️  [xy-lib] 找不到文件: ${folder}/${entry}`);
                        failCount++;
                        continue;
                    }

                    const ext = path.extname(entry).toLowerCase();
                    try {
                        if (ext === '.mjs') {
                            await importEntry(entryPath, cacheBust);
                            log(`✅ [xy-lib] [import] ${folder}/${entry}`);
                        } else if (ext === '.cjs') {
                            requireEntry(entryPath, cacheBust);
                            log(`✅ [xy-lib] [require] ${folder}/${entry}`);
                        } else {
                            if (moduleType === 'module') {
                                await importEntry(entryPath, cacheBust);
                                log(`✅ [xy-lib] [import] ${folder}/${entry} (type=module)`);
                            } else {
                                requireEntry(entryPath, cacheBust);
                                log(`✅ [xy-lib] [require] ${folder}/${entry}`);
                            }
                        }
                        successCount++;
                    } catch (e) {
                        logErr(`❌ [xy-lib] 加载 ${folder}/${entry} 失败: ${e.message}`);
                        if (e.stack) logErr(e.stack);
                        failCount++;
                    }
                }
            });

            // 等待当前优先级的所有模块加载完毕，再进入下一级
            await Promise.all(promises);
        }
    } finally {
        isLoading = false;
    }

    log(`📊 [xy-lib] 扫描完成，共注册 ${successCount} 个，失败 ${failCount} 个。`);
    return { successCount, failCount };
}

module.exports = loadAllModules;
module.exports.loadAllModules = loadAllModules;