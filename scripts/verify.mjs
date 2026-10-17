// dsh-file-actions 自检脚本
// 只验证结构、语法、路由与拒绝分支，不触发任何真实的文件打开动作。
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('  PASS  ' + name);
    })
    .catch((err) => {
      failed += 1;
      console.log('  FAIL  ' + name);
      console.log('        ' + (err instanceof Error ? err.message : String(err)));
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- 断言用例

async function main() {
  console.log('dsh-file-actions verify');

  const capturedClient = { definition: null, exports: null };
  const clientSource = await readFile(join(root, 'lib', 'client.js'), 'utf8');

  const pkgText = await readFile(join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgText);

  await check('package.json 基本字段', () => {
    assert(pkg.name === 'dsh-file-actions', 'name 不符');
    assert(pkg.type === 'module', 'type 必须是 module');
    assert(pkg.main === './lib/index.js', 'main 指向错误');
    assert(pkg.exports['./client'].default === './lib/client.js', 'client 导出缺失');
  });

  await check('dsh 元数据声明了 bundle 与 client', () => {
    assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle.patch 缺失');
    assert(pkg.dsh.client && pkg.dsh.client.platform === 'web', 'client.platform 必须是 web');
    assert(Array.isArray(pkg.dsh.client.inject), 'client.inject 必须是数组');
  });

  await check('cordis.patch.yml 结构', async () => {
    const text = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
    assert(/insert:/.test(text), '缺少 insert 段');
    assert(/dsh-file-actions/.test(text), '缺少插件名');
    assert(/id:\s*file-actions/.test(text), '缺少条目 id');
  });

  await check('客户端模块可被加载器注册', async () => {
    globalThis.window = {
      __ModuleLoader__: {
        load(definition) {
          capturedClient.definition = definition;
        }
      }
    };
    await import(pathToFileURL(join(root, 'lib', 'client.js')).href);
    assert(capturedClient.definition !== null, '未调用 __ModuleLoader__.load');
    assert(capturedClient.definition.id === 'dsh-file-actions', '模块 id 不符');
    assert(typeof capturedClient.definition.factory === 'function', 'factory 缺失');
  });

  await check('客户端 factory 导出 apply 与 inject', () => {
    const fakeReact = {
      createElement: () => null,
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn
    };
    const fakeRequire = (name) => {
      if (name === 'react') return fakeReact;
      throw new Error('unexpected require: ' + name);
    };
    capturedClient.exports = capturedClient.definition.factory(fakeRequire);
    assert(typeof capturedClient.exports.apply === 'function', 'apply 未导出');
    assert(Array.isArray(capturedClient.exports.inject), 'inject 必须是数组');
  });

  await check('客户端区分文件与网址两类引用', () => {
    const code = clientSource;
    assert(code.includes('data-ref-chip'), '缺少 chip 识别');
    assert(code.includes('file://'), '缺少 file 链接识别');
    assert(code.includes('closest("code")'), '缺少行内代码识别');
    assert(code.includes('URL_LIKE'), '缺少网址识别');
    assert(code.includes('buildUrlMenu'), '缺少网址菜单分支');
    assert(code.includes('open-url'), '网址菜单未接入 open-url 动作');
  });

  const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);

  await check('宿主导出 name 与 apply', () => {
    assert(plugin.name === 'file-actions', 'name 不符');
    assert(typeof plugin.apply === 'function', 'apply 缺失');
    assert(Array.isArray(plugin.inject), 'inject 必须是数组');
  });

  // 用假 ctx 走一遍注册流程，捕获注册的路由
  const routes = [];
  const fakeHttpCtx = {
    effect(fn) {
      fn();
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  const fakeCtx = {
    inject(deps, cb) {
      assert(Array.isArray(deps), 'inject 依赖必须是数组');
      assert(deps.includes('webServer'), '应声明 webServer 依赖');
      cb(fakeHttpCtx);
    }
  };

  plugin.apply(fakeCtx);

  await check('注册了 /api/file-actions 前缀路由', () => {
    assert(routes.length === 1, '路由数量应为 1，实际 ' + routes.length);
    assert(routes[0].kind === 'prefix', '路由类型应为 prefix');
    assert(routes[0].path === '/api/file-actions', '路径不符：' + routes[0].path);
    assert(typeof routes[0].handler === 'function', 'handler 缺失');
  });

  const handler = routes[0].handler;

  function call(method, url, body) {
    return new Promise((resolveCall, rejectCall) => {
      const req = {
        method,
        url,
        on(event, cb) {
          if (event === 'data' && body !== undefined) {
            cb(Buffer.from(JSON.stringify(body)));
          }
          if (event === 'end') cb();
        }
      };
      let statusCode = 0;
      let payload = '';
      const res = {
        writeHead(code) {
          statusCode = code;
        },
        end(text) {
          payload = text ?? '';
          resolveCall({ status: statusCode, body: JSON.parse(payload || '{}') });
        }
      };
      Promise.resolve(handler(req, res)).catch(rejectCall);
    });
  }

  await check('GET /health 返回 ready', async () => {
    const out = await call('GET', '/api/file-actions/health');
    assert(out.status === 200, '状态码应为 200，实际 ' + out.status);
    assert(out.body.ok === true, 'ok 应为 true');
    assert(out.body.data.status === 'ready', 'status 应为 ready');
    assert(Array.isArray(out.body.data.actions), 'actions 应为数组');
  });

  await check('未知 action 被拒绝', async () => {
    const out = await call('POST', '/api/file-actions/exec', { action: 'rm -rf', path: 'C:\\' });
    assert(out.status === 400, '状态码应为 400，实际 ' + out.status);
    assert(out.body.ok === false, 'ok 应为 false');
    assert(/unknown action/.test(out.body.error), '错误信息不符：' + out.body.error);
  });

  await check('不存在的路径被拒绝', async () => {
    const out = await call('POST', '/api/file-actions/exec', {
      action: 'reveal',
      path: 'C:\\__dsh_file_actions_not_exist__\\nope.txt'
    });
    assert(out.status === 400, '状态码应为 400，实际 ' + out.status);
    assert(out.body.ok === false, 'ok 应为 false');
    assert(/does not exist/.test(out.body.error), '错误信息不符：' + out.body.error);
  });

  await check('空路径被拒绝', async () => {
    const out = await call('POST', '/api/file-actions/exec', { action: 'open', path: '   ' });
    assert(out.status === 400, '状态码应为 400');
    assert(/empty/.test(out.body.error), '错误信息不符：' + out.body.error);
  });

  await check('文件动作遇到网页地址被拒绝', async () => {
    const out = await call('POST', '/api/file-actions/exec', {
      action: 'reveal',
      path: 'http://127.0.0.1:1420/prototype/index.html'
    });
    assert(out.status === 400, '状态码应为 400，实际 ' + out.status);
    assert(/web URL/.test(out.body.error), '错误信息不符：' + out.body.error);
    assert(!/profiles/.test(out.body.error), '不应再把 URL 拼成本地路径：' + out.body.error);
  });

  await check('open-url 拒绝非 http 协议', async () => {
    const out = await call('POST', '/api/file-actions/exec', { action: 'open-url', path: 'file:///C:/x' });
    assert(out.status === 400, '状态码应为 400，实际 ' + out.status);
    assert(/only http/.test(out.body.error), '错误信息不符：' + out.body.error);
  });

  await check('open-url 拒绝含引号的地址', async () => {
    const out = await call('POST', '/api/file-actions/exec', {
      action: 'open-url',
      path: 'http://a.com/"&calc'
    });
    assert(out.status === 400, '状态码应为 400，实际 ' + out.status);
    assert(/quote/.test(out.body.error), '错误信息不符：' + out.body.error);
  });

  await check('open-url 拒绝空地址', async () => {
    const out = await call('POST', '/api/file-actions/exec', { action: 'open-url', path: '' });
    assert(out.status === 400, '状态码应为 400');
    assert(/empty/.test(out.body.error), '错误信息不符：' + out.body.error);
  });

  await check('非法路由返回 404', async () => {
    const out = await call('GET', '/api/file-actions/nope');
    assert(out.status === 404, '状态码应为 404，实际 ' + out.status);
  });

  console.log('');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('verify 崩溃:', err);
  process.exitCode = 1;
});
