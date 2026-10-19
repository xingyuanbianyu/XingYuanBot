import { createCanvas, registerFont, loadImage } from 'canvas';
import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_PATH = join(__dirname, 'menu.json');
const TEMP_DIR = resolve(__dirname, '../../../temp');

// 🌟 明确规定必须存在的四个文件夹
const DEFAULT_DIR = join(TEMP_DIR, 'default'); // 放全局配置
const GROUP_DIR = join(TEMP_DIR, 'group');     // 放群专属配置和群专属图片
const CARD_DIR = join(TEMP_DIR, 'card');       // 放随机图片池
const CACHE_DIR = join(TEMP_DIR, 'cache');     // 🛡️ 安全区：只放生成的缓存图

const DEFAULT_CONFIG_PATH = join(DEFAULT_DIR, 'config.yaml');

// 字体注册
const FONT_PATH = resolve(__dirname, '../../../fonts/NotoSansSC-Regular.otf');
try { registerFont(FONT_PATH, { family: 'CustomFont' }); } catch (err) {}
const FONT_STACK = '"CustomFont", "Microsoft YaHei", sans-serif';
function setFont(ctx, style, size) { ctx.font = `${style} ${size}px ${FONT_STACK}`; }

// 确保这 4 个文件夹永远存在
const ensureDirs = () => {
    [TEMP_DIR, DEFAULT_DIR, GROUP_DIR, CARD_DIR, CACHE_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
};
ensureDirs();

// 内存缓存
let cachedDefaultConfig = null;
let cachedGroupConfigs = {};
let cachedCardFiles = null;

const initDefaultConfig = () => {
    if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
        fs.writeFileSync(DEFAULT_CONFIG_PATH, `default_bg: ""\noverlay_color: "rgba(0, 0, 0, 0.65)"\ntitle_color: "#ffffff"\ntext_color: "#dddddd"\ncmd_color: "#88d3ce"\n`, 'utf8');
    }
    try { cachedDefaultConfig = yaml.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) || {}; } catch (e) { cachedDefaultConfig = {}; }
};
initDefaultConfig();

// 监听变化
fs.watch(DEFAULT_CONFIG_PATH, (event) => { if (event === 'change') initDefaultConfig(); });
fs.watch(GROUP_DIR, (event, filename) => {
    if (filename && filename.endsWith('.yaml')) {
        delete cachedGroupConfigs[filename.replace('.yaml', '')];
    }
});
fs.watch(CARD_DIR, (event) => { 
    if (event === 'rename' || event === 'change') cachedCardFiles = null; 
});

// ==========================================
// 🌟 安全清理：只盯着 cache 文件夹，绝不误伤其他人
// ==========================================
function cleanCacheDir() {
    try {
        if (!fs.existsSync(CACHE_DIR)) return;
        
        // 只读取 cache 文件夹里的文件
        const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.png'));
        
        if (files.length > 50) { // 超过 50 张开始杀
            const fileStats = files.map(f => ({ name: f, time: fs.statSync(join(CACHE_DIR, f)).mtimeMs }))
                                    .sort((a, b) => a.time - b.time);
            const deleteCount = files.length - 50;
            for (let i = 0; i < deleteCount; i++) {
                const imgToDel = fileStats[i].name;
                fs.unlinkSync(join(CACHE_DIR, imgToDel));
                // 顺手干掉对应的版本 txt
                const txtToDel = imgToDel.replace('.png', '.txt');
                const txtPath = join(CACHE_DIR, txtToDel);
                if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
            }
            console.log(`[Card] 🧹 安全清理了 ${deleteCount} 张过期的缓存图`);
        }
    } catch (e) {
        console.error('[Card] 清理缓存失败:', e.message);
    }
}

// ==========================================
// 生成帮助卡片
// ==========================================
export async function generateHelpCard(chatId = null) {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const { version, title, footer, commands, categories } = data;

  const isGroup = chatId && String(chatId).length > 5; 
  
  // 🌟 所有生成的文件，全扔在 cache 文件夹里
  const fileName = isGroup ? `help_group_${chatId}.png` : 'help_private.png';
  const verName = isGroup ? `help_group_${chatId}.txt` : 'help_private.txt';
  
  const IMG_PATH = join(CACHE_DIR, fileName);
  const VER_PATH = join(CACHE_DIR, verName);

  // 检查缓存
  let oldVer = 0;
  if (fs.existsSync(VER_PATH)) {
      oldVer = parseInt(fs.readFileSync(VER_PATH, 'utf-8').trim()) || 0;
  }
  if (version === oldVer && fs.existsSync(IMG_PATH)) {
      return IMG_PATH; 
  }

  console.log(`[Card] 正在生成帮助图: ${fileName}`);
  cleanCacheDir(); // 生成前安全清理

  // 读取配置
  let config = { default_bg: "", overlay_color: "rgba(0,0,0,0.65)", title_color: "#fff", text_color: "#ddd", cmd_color: "#88d3ce", ...cachedDefaultConfig };
  
  // 🌟 群专属配置：严格去 group 文件夹里找 群号.yaml
  if (isGroup) {
      if (!cachedGroupConfigs[chatId]) {
          const p = join(GROUP_DIR, `${chatId}.yaml`);
          cachedGroupConfigs[chatId] = fs.existsSync(p) ? yaml.parse(fs.readFileSync(p, 'utf8')) || {} : {};
      }
      config = { ...config, ...cachedGroupConfigs[chatId] };
  }

  // 查找背景图
  let bgPath = null;
  
  // 1. 优先去 group 文件夹找 群号.jpg
  if (isGroup) {
      for (const ext of ['.jpg', '.jpeg', '.png']) {
          const p = join(GROUP_DIR, `${chatId}${ext}`);
          if (fs.existsSync(p)) { bgPath = p; break; }
      }
  }
  
  // 2. 其次看 config.yaml 里有没有指定
  if (!bgPath && config.default_bg) {
      const p = path.isAbsolute(config.default_bg) ? config.default_bg : resolve(TEMP_DIR, config.default_bg);
      if (fs.existsSync(p)) bgPath = p;
  } 
  
  // 3. 最后去 card 文件夹随机抽
  if (!bgPath) {
      if (!cachedCardFiles) cachedCardFiles = fs.readdirSync(CARD_DIR).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      if (cachedCardFiles.length > 0) {
          bgPath = join(CARD_DIR, cachedCardFiles[Math.floor(Math.random() * cachedCardFiles.length)]);
      }
  }

  // 画布计算
  const CANVAS_WIDTH = 1000, PADDING_X = 60, PADDING_TOP = 80, PADDING_BOTTOM = 60;
  let y = PADDING_TOP, TITLE_HEIGHT = 50, contentHeight = 0;
  for (const cat of categories) {
    contentHeight += 50;
    for (const id of cat.items) { if (commands[id]) contentHeight += 40; }
    contentHeight += 20;
  }
  const CANVAS_HEIGHT = PADDING_TOP + TITLE_HEIGHT + contentHeight + PADDING_BOTTOM;
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');

  // 绘制背景
  let bgLoaded = false;
  if (bgPath) {
      try {
          const image = await loadImage(bgPath);
          const scale = Math.max(CANVAS_WIDTH / image.width, CANVAS_HEIGHT / image.height);
          ctx.drawImage(image, (CANVAS_WIDTH - image.width * scale) / 2, (CANVAS_HEIGHT - image.height * scale) / 2, image.width * scale, image.height * scale);
          bgLoaded = true;
      } catch (e) {}
  }
  if (!bgLoaded) { ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT); }
  
  // 遮罩与文字
  ctx.fillStyle = config.overlay_color; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = config.title_color; setFont(ctx, 'bold', 36);
  ctx.fillText(title || '星缘机器人 · 帮助', PADDING_X, PADDING_TOP + 40);
  ctx.strokeStyle = '#ffffff33'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(PADDING_X, PADDING_TOP + 55); ctx.lineTo(CANVAS_WIDTH - PADDING_X, PADDING_TOP + 55); ctx.stroke();
  
  y = PADDING_TOP + TITLE_HEIGHT + 20;
  for (const cat of categories) {
    ctx.fillStyle = cat.color || config.cmd_color; setFont(ctx, 'bold', 26);
    const cleanCatName = cat.name.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
    ctx.fillText(cleanCatName || cat.name, PADDING_X, y); y += 40;
    
    setFont(ctx, 'normal', 22); ctx.fillStyle = config.text_color;
    for (const id of cat.items) {
      const item = commands[id];
      if (item) { ctx.fillText(`${item.cmd}  ${item.desc}`, PADDING_X + 20, y); y += 40; }
    }
    y += 20;
  }
  ctx.fillStyle = '#888888'; setFont(ctx, 'normal', 16); ctx.fillText(footer || '', PADDING_X, CANVAS_HEIGHT - 20);

  // 保存到 cache 文件夹
  fs.writeFileSync(IMG_PATH, canvas.toBuffer('image/png'));
  fs.writeFileSync(VER_PATH, String(version));

  return IMG_PATH;
}