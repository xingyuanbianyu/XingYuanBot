import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = join(__dirname, '../xy-data/config.yaml');

console.log('=== 调试信息 ===');
console.log('__dirname =', __dirname);
console.log('CONFIG_PATH =', CONFIG_PATH);
console.log('===============');


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
            console.warn(`⚠️ 配置文件不存在: ${CONFIG_PATH}`);
            configData = getDefaultConfig();
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
