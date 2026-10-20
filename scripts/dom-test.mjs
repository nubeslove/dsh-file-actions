// 在真实 Chromium 里加载客户端脚本，用真实 DOM 验证引用识别。
// 这类问题（某些蓝色文件右键没反应）静态断言抓不到，必须跑真 DOM。
//
// 运行前需要能解析 playwright：默认从 DSH profile 目录解析，
// 可用 DSH_HOME / DSH_PROFILE 覆盖。
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const profileHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileEnv = process.env.DSH_PROFILE;
const profile = !profileEnv
  ? join(profileHome, 'profiles', 'desktop')
  : isAbsolute(profileEnv)
    ? profileEnv
    : join(profileHome, 'profiles', profileEnv);

const req = createRequire(join(profile, 'package.json'));
const { chromium } = req('playwright');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err instanceof Error ? err.message : String(err)));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const CASES = [
  {
    name: 'chip: 普通文件',
    html: '<span data-ref-chip="file" title="@report.md">report.md</span>',
    expect: { kind: 'file', value: 'report.md' }
  },
  {
    name: 'chip: skill 引用（曾经被误排除）',
    html: '<span data-ref-chip="skill" title="@scripts/build.cmd">build.cmd</span>',
    expect: { kind: 'file', value: 'scripts/build.cmd' }
  },
  {
    name: 'chip: 只有文本没有 title 的 .cmd',
    html: '<span data-ref-chip="file">deploy.cmd</span>',
    expect: { kind: 'file', value: 'deploy.cmd' }
  },
  {
    name: 'chip: folder（目录路径也要能识别）',
    html: '<span data-ref-chip="folder" title="@src/">src</span>',
    expect: { kind: 'file', value: 'src/' }
  },
  {
    name: 'chip: session 引用应被忽略',
    html: '<span data-ref-chip="session" title="@some-session">some-session</span>',
    expect: null
  },
  {
    name: 'title 属性携带完整 Windows 路径',
    html: '<span title="E:\\project\\a\\run.cmd">run.cmd</span>',
    expect: { kind: 'file', value: 'E:\\project\\a\\run.cmd' }
  },
  {
    name: '行内代码 .cmd',
    html: '<code>start-all.cmd</code>',
    expect: { kind: 'file', value: 'start-all.cmd' }
  },
  {
    name: '行内代码 .ps1',
    html: '<code>scripts/release.ps1</code>',
    expect: { kind: 'file', value: 'scripts/release.ps1' }
  },
  {
    name: '行内代码里的网址',
    html: '<code>http://127.0.0.1:1420/a.html</code>',
    expect: { kind: 'url', value: 'http://127.0.0.1:1420/a.html' }
  },
  {
    name: 'file:// 链接',
    html: '<a href="file:///C:/tmp/x.txt">x.txt</a>',
    expect: { kind: 'file' }
  },
  {
    name: '普通段落不应命中',
    html: '<div>这是一段普通说明文字，没有文件</div>',
    expect: null
  },
  {
    name: '带中文 title 的按钮不应命中',
    html: '<button title="点击复制">复制</button>',
    expect: null
  },
  {
    name: '子元素上的右键要能冒泡到 chip',
    html: '<span data-ref-chip="file" title="@a/b.cmd"><i class="icon">&lt;/&gt;</i><span>b.cmd</span></span>',
    selector: '.icon',
    expect: { kind: 'file', value: 'a/b.cmd' }
  }
];

async function main() {
  console.log('dsh-file-actions DOM test');

  const clientSrc = await readFile(join(root, 'lib', 'client.js'), 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');

  await page.addScriptTag({ content: 'window.__ModuleLoader__ = { load: function (d) { window.__def = d; } };' });
  await page.addScriptTag({ content: clientSrc });

  await check('客户端模块已注册并可导出测试钩子', async () => {
    const ok = await page.evaluate(() => {
      if (!window.__def || typeof window.__def.factory !== 'function') return false;
      window.__plugin = window.__def.factory(function () {
        return { createElement: function () { return null; } };
      });
      return !!(window.__plugin && window.__plugin.__test);
    });
    assert(ok, 'factory 未导出 __test');
  });

  for (const testCase of CASES) {
    await check(testCase.name, async () => {
      const result = await page.evaluate(
        ({ html, selector }) => {
          const root = document.getElementById('root');
          root.innerHTML = html;
          const el = selector
            ? root.querySelector(selector)
            : root.firstElementChild.firstElementChild || root.firstElementChild;
          return window.__plugin.__test.resolveFromEvent(el);
        },
        { html: testCase.html, selector: testCase.selector }
      );

      if (testCase.expect === null) {
        assert(result === null, '应无命中，实际 ' + JSON.stringify(result));
        return;
      }
      assert(result !== null, '应命中，实际 null');
      assert(result.kind === testCase.expect.kind, 'kind 应为 ' + testCase.expect.kind + '，实际 ' + result.kind);
      if (testCase.expect.value !== undefined) {
        assert(
          result.value === testCase.expect.value,
          'value 应为 ' + JSON.stringify(testCase.expect.value) + '，实际 ' + JSON.stringify(result.value)
        );
      }
    });
  }

  await browser.close();

  console.log('');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
}

main().catch((err) => {
  console.error('dom-test 崩溃:', err);
  process.exitCode = 1;
});

