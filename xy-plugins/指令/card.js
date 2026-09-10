import { createCanvas, registerFont } from 'canvas'; // 1. 引入 registerFont
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_PATH = join(__dirname, 'menu.json');
const TEMP_DIR = resolve(__dirname, '../../temp');
const IMG_PATH = join(TEMP_DIR, 'help_card.png');
const VER_PATH = join(TEMP_DIR, 'version.txt');

// 2. 定义字体路径，指向项目根目录下的 fonts 文件夹
const FONT_PATH = resolve(__dirname, '../../fonts/NotoSansSC-Regular.otf');

// 3. 注册字体
// 这行代码会告诉 canvas 库优先使用我们指定的字体文件
try {
  registerFont(FONT_PATH, { family: 'CustomFont' });
  console.log('[Card] 自定义字体加载成功');
} catch (err) {
  console.warn('[Card] 警告：自定义字体加载失败，将回退到系统字体。请确保 fonts/NotoSansSC-Regular.otf 文件存在。');
}

// 4. 定义字体栈，优先使用我们注册的 'CustomFont'
const FONT_STACK = '"CustomFont", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

function setFont(ctx, style, size) {
  ctx.font = `${style} ${size}px ${FONT_STACK}`;
}

export async function generateHelpCard() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const { version, title, footer, commands, categories } = data;

  let oldVer = 0;
  if (fs.existsSync(VER_PATH)) {
    oldVer = parseInt(fs.readFileSync(VER_PATH, 'utf-8').trim()) || 0;
  }

  if (version === oldVer && fs.existsSync(IMG_PATH)) {
    console.log('[Card] 版本未变化，使用缓存图片');
    return IMG_PATH;
  }

  console.log('[Card] 检测到数据变化，正在重新生成帮助卡片...');

  const CANVAS_WIDTH = 1200;
  const PADDING_X = 60;
  const PADDING_TOP = 80;
  const PADDING_BOTTOM = 60;

  let y = PADDING_TOP;
  const TITLE_HEIGHT = 50;
  let contentHeight = 0;

  for (const cat of categories) {
    contentHeight += 50;
    for (const id of cat.items) {
      if (commands[id]) {
        contentHeight += 40;
      }
    }
    contentHeight += 20;
  }

  const CANVAS_HEIGHT = PADDING_TOP + TITLE_HEIGHT + contentHeight + PADDING_BOTTOM;

  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // 使用封装好的 setFont 函数
  ctx.fillStyle = '#ffffff';
  setFont(ctx, 'bold', 36);
  ctx.fillText(title || '星缘机器人 · 帮助', PADDING_X, PADDING_TOP + 40);

  ctx.strokeStyle = '#ffffff33';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PADDING_X, PADDING_TOP + 55);
  ctx.lineTo(CANVAS_WIDTH - PADDING_X, PADDING_TOP + 55);
  ctx.stroke();

  y = PADDING_TOP + TITLE_HEIGHT + 20;

  for (const cat of categories) {
    ctx.fillStyle = cat.color || '#a0d0ff';
    setFont(ctx, 'bold', 26);
    ctx.fillText(cat.name, PADDING_X, y);
    y += 40;

    setFont(ctx, 'normal', 22);
    ctx.fillStyle = '#e0e0e0';
    for (const id of cat.items) {
      const item = commands[id];
      if (item) {
        ctx.fillText(`${item.cmd}  ${item.desc}`, PADDING_X + 20, y);
        y += 40;
      }
    }
    y += 20;
  }

  ctx.fillStyle = '#888888';
  setFont(ctx, 'normal', 16);
  ctx.fillText(footer || '', PADDING_X, CANVAS_HEIGHT - 20);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(IMG_PATH, buffer);
  fs.writeFileSync(VER_PATH, String(version));

  console.log('[Card] 生成完毕，已保存到 temp/');
  return IMG_PATH;
}
