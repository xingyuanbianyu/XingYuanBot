import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = join(__dirname, '../xy-data/config.yaml');

let configData = null;

function getDefaultConfig() {
    return {
        blacklist_qq: [],
        blacklist_group: [],
        whitelist_qq: [],
        whitelist_group: [],
    };
}

export function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            console.warn(`⚠️ 配置文件不存在，正在自动创建: ${CONFIG_PATH}`);
            
            // 1. 确保 xy-data 文件夹存在（没有就新建）
            const dir = dirname(CONFIG_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // 2. 生成默认配置并写入到 config.yaml 中
            configData = getDefaultConfig();
            fs.writeFileSync(CONFIG_PATH, YAML.stringify(configData), 'utf8');
            
            console.log(`✅ 成功创建并初始化 config.yaml`);
            return configData;
        }

        const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = YAML.parse(fileContents) || {};
        
        configData = {
            blacklist_qq: parsed.blacklist_qq || [],
            blacklist_group: parsed.blacklist_group || [],
            whitelist_qq: parsed.whitelist_qq || [],
            whitelist_group: parsed.whitelist_group || [],
        };
        console.log('✅ [配置] 成功读取 config.yaml');
        return configData;
    } catch (e) {
        console.error(`❌ [配置] 解析 config.yaml 失败:`, e.message);
        configData = getDefaultConfig();
        return configData;
    }
}

export default loadConfig();
