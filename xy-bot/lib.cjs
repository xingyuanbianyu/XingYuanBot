const fs = require('fs');
const path = require('path');

// 1. 重新定义扫描目标目录：定位到 xy-bot 的上一级目录下的 xy-lib
const targetDir = path.join(__dirname, '../xy-lib');
console.log('📦 [xy-lib] 开始扫描模块目录:', targetDir);

async function loadAllModules() {
    // 2. 扫描 targetDir
    const folders = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    let successCount = 0;
    let failCount = 0;

    for (const folder of folders) {
        // 3. 拼接路径时同样使用 targetDir
        const folderPath = path.join(targetDir, folder);
        const ruleFile = path.join(folderPath, 'lib.json');

        if (!fs.existsSync(ruleFile)) {
            console.log(`⏭️  [xy-lib] 忽略目录 (无 lib.json): ${folder}`);
            continue;
        }

        // 读取模块配置
        let rule;
        try {
            rule = JSON.parse(fs.readFileSync(ruleFile, 'utf8'));
        } catch (e) {
            console.error(`❌ [xy-lib] 解析 ${folder}/lib.json 失败:`, e.message);
            failCount++;
            continue;
        }

        if (!rule.enable) {
            console.log(`⏸️  [xy-lib] 跳过未启用模块: ${folder}`);
            continue;
        }

        // 读取模块的 package.json（可选，没有就不管）
        const pkgFile = path.join(folderPath, 'package.json');
        let moduleType = null; // null 表示没有配置

        if (fs.existsSync(pkgFile)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
                if (pkg.type) {
                    moduleType = pkg.type;
                    console.log(`📋 [xy-lib] ${folder} 的 package.json type = "${moduleType}"`);
                }
            } catch (e) {
                console.warn(`⚠️  [xy-lib] ${folder}/package.json 解析失败，忽略 type 字段`);
            }
        }

        // 加载入口文件
        for (const entry of (rule.entries || [])) {
            const entryPath = path.join(folderPath, entry);
            const ext = path.extname(entry).toLowerCase();

            if (!fs.existsSync(entryPath)) {
                console.warn(`⚠️  [xy-lib] 找不到文件: ${folder}/${entry}`);
                failCount++;
                continue;
            }

            try {
                if (ext === '.mjs') {
                    // .mjs 强制用 import()
                    await import(`file://${entryPath}`);
                    console.log(`✅ [xy-lib] [import] ${folder}/${entry}`);
                } else if (ext === '.cjs') {
                    // .cjs 强制用 require()
                    require(entryPath);
                    console.log(`✅ [xy-lib] [require] ${folder}/${entry}`);
                } else {
                    // .js 根据 package.json 的 type 决定
                    if (moduleType === 'module') {
                        await import(`file://${entryPath}`);
                        console.log(`✅ [xy-lib] [import] ${folder}/${entry} (type=module)`);
                    } else {
                        require(entryPath);
                        console.log(`✅ [xy-lib] [require] ${folder}/${entry}`);
                    }
                }
                successCount++;
            } catch (e) {
                console.error(`❌ [xy-lib] 加载 ${folder}/${entry} 失败:`, e.message);
                failCount++;
            }
        }
    }

    console.log(`📊 [xy-lib] 扫描完成，共注册 ${successCount} 个，失败 ${failCount} 个。`);
}

loadAllModules();

module.exports = loadAllModules;
