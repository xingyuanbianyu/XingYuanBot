import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 修正后的正确路径：当前目录的上一级(xy-config/xy-bot -> xy-config)下的 xy-data/config.yaml
const CONFIG_PATH = path.join(__dirname, '../xy-data/config.yaml');

let configData = null;

// 获取默认空配置
function getDefaultConfig() {
    return {
        blacklist_qq: [],
        blacklist_group: [],
        whitelist_qq: [],
        whitelist_group: [],
    };
}

// 核心读取逻辑
export function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            console.warn(`⚠️  配置文件不存在: ${CONFIG_PATH}`);
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

// 默认导出一份配置数据，方便直接 require/import
export default loadConfig();
