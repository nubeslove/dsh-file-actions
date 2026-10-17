// 生成 README 用的界面示意图。
//
// 这两张图不是 DSH 真实运行截图，而是把 lib/client.js 里同一套菜单 CSS 与
// DSH 消息区样式复刻到 HTML 后渲染出来的示意，用于说明菜单长什么样。
//
// 运行前需要能解析到 playwright：脚本默认从 DSH profile 目录解析，
// 可用 DSH_PROFILE 环境变量覆盖。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const docsDir = join(root, 'docs');

// DSH 会导出 DSH_HOME 与 DSH_PROFILE（后者通常是相对名，如 desktop）。
const profileHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileEnv = process.env.DSH_PROFILE;
const profile = !profileEnv
  ? join(profileHome, 'profiles', 'desktop')
  : isAbsolute(profileEnv)
    ? profileEnv
    : join(profileHome, 'profiles', profileEnv);

const req = createRequire(join(profile, 'package.json'));
const { chromium } = req('playwright');

const pagePath = new URL('./demo/menus.html', import.meta.url).href;

async function main() {
  await mkdir(docsDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 880, height: 1200 },
    deviceScaleFactor: 2
  });
  await page.goto(pagePath, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const targets = [
    { id: 'shot-file', out: 'file-menu.png' },
    { id: 'shot-url', out: 'url-menu.png' }
  ];

  for (const target of targets) {
    const el = page.locator('#' + target.id);
    await el.screenshot({ path: join(docsDir, target.out) });
    console.log('wrote', join(docsDir, target.out));
  }

  await browser.close();
}

main().catch((err) => {
  console.error('生成截图失败:', err);
  process.exitCode = 1;
});
