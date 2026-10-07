const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const targetDir = path.join(__dirname, '../xy-lib');

async function loadAllModules() {
    console.log('📦 [xy-lib] 开始扫描目录:', targetDir);
    let successCount = 0;
    let failCount = 0;

    try {
        // 1. 扫描两层目录
        const foldersToProcess = [];
        const level1Dirs = fs.readdirSync(targetDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const dir1 of level1Dirs) {
            const path1 = path.join(targetDir, dir1);
            if (fs.existsSync(path.join(path1, 'lib.json'))) {
                foldersToProcess.push(path1);
                continue;
            }
            const level2Dirs = fs.readdirSync(path1, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            for (const dir2 of level2Dirs) {
                const path2 = path.join(path1, dir2);
                if (fs.existsSync(path.join(path2, 'lib.json'))) {
                    foldersToProcess.push(path2);
                }
            }
        }

        // 2. 遍历并加载
        for (const folderPath of foldersToProcess) {
            const folderName = path.basename(folderPath);
            const ruleFile = path.join(folderPath, 'lib.json');

            let rule;
            try {
                rule = JSON.parse(fs.readFileSync(ruleFile, 'utf8'));
            } catch (e) { failCount++; continue; }
            if (!rule.enable) continue;

            // 读取 package.json 用于 .js 文件的类型判断
            const pkgFile = path.join(folderPath, 'package.json');
            let packageJsonType = null;
            if (fs.existsSync(pkgFile)) {
                try { 
                    packageJsonType = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).type; 
                } catch (e) {}
            }

            for (const entry of (rule.entries || [])) {
                const entryPath = path.join(folderPath, entry);
                const ext = path.extname(entry).toLowerCase();

                if (!fs.existsSync(entryPath)) { failCount++; continue; }

                try {
                    // 🌟 核心分流逻辑
                    let isESM = false;
                    if (ext === '.mjs') {
                        isESM = true;
                    } else if (ext === '.js') {
                        // 没有 package.json，默认按 CJS 处理
                        isESM = (packageJsonType === 'module');
                    }

                    if (isESM) {
                        await import(pathToFileURL(entryPath).href);
                        console.log(`✅ [xy-lib] [import] ${folderName}/${entry}`);
                    } else {
                        require(entryPath);
                        console.log(`✅ [xy-lib] [require] ${folderName}/${entry}`);
                    }
                    successCount++;
                } catch (e) {
                    console.error(`❌ [xy-lib] 加载 ${folderName}/${entry} 失败:`, e.message);
                    failCount++;
                }
            }
        }
    } catch (err) {
        console.error(`❌ [xy-lib] 扫描根目录失败:`, err.message);
    }

    console.log(`📊 [xy-lib] 加载完成，共成功 ${successCount} 个，失败 ${failCount} 个。`);
}

module.exports = loadAllModules;