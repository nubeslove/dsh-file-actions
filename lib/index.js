// dsh-file-actions — host 侧
// 职责：为 Web 客户端提供「对本地文件执行系统动作」的受限接口。
// 文件动作三个：在资源管理器中定位、用默认程序打开、用浏览器打开。
// 另有一个网址动作 open-url，只接受 http/https，用于处理引用里的网页链接。
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

export const name = 'file-actions';
export const inject = [];

const PREFIX = '/api/file-actions';
const MAX_PATH_LENGTH = 4096;

const ACTIONS = new Set(['reveal', 'open', 'browser', 'open-url']);

// ---------------------------------------------------------------- 路径处理

/**
 * 把客户端传来的引用文本还原成本地绝对路径。
 * 接受的形态：普通路径、`@path`、`@"path with spaces"`、`file:///C:/x/y`。
 * @param {unknown} raw 客户端传入的原始引用。
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function resolveTarget(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'path must be a string' };
  let text = raw.trim();
  if (!text) return { ok: false, error: 'path is empty' };
  if (text.length > MAX_PATH_LENGTH) return { ok: false, error: 'path too long' };
  if (text.includes('\u0000')) return { ok: false, error: 'path contains NUL' };
  // 网页地址不是本地文件，早退避免被当作相对路径拼到工作目录上
  if (/^https?:\/\//i.test(text)) {
    return { ok: false, error: 'this is a web URL, not a local file' };
  }

  // 引用语法：@path / @"path"
  if (text.startsWith('@')) text = text.slice(1);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  text = text.trim();

  // file:// URL
  if (/^file:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      text = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(text)) text = text.slice(1);
      text = text.replace(/\//g, '\\');
    } catch {
      return { ok: false, error: 'invalid file url' };
    }
  }

  // #L24 / #L24-L30 行号片段，去掉后再定位
  text = text.replace(/#L\d+(?:-L?\d+)?$/i, '');
  if (!text) return { ok: false, error: 'path is empty after normalization' };

  const absolute = isAbsolute(text) ? normalize(text) : resolve(process.cwd(), text);
  if (!existsSync(absolute)) return { ok: false, error: 'path does not exist: ' + absolute };

  try {
    statSync(absolute);
  } catch (err) {
    return { ok: false, error: 'cannot stat path: ' + (err instanceof Error ? err.message : String(err)) };
  }
  return { ok: true, path: absolute };
}

// ---------------------------------------------------------------- 系统动作

/**
 * 启动一个分离的后台进程并立即放弃句柄，避免阻塞宿主事件循环。
 * windowsVerbatimArguments 保证带空格的路径按我们拼好的引号原样交给 Windows。
 * showWindow 用于 GUI 程序：windowsHide 会注入 CREATE_NO_WINDOW，
 * explorer.exe 被这样启动后会静默退出，不转发 /select 请求。
 */
function launch(command, args, verbatim, options) {
  const showWindow = options === true;
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: !showWindow,
    windowsVerbatimArguments: verbatim === true
  });
  child.unref();
}

function revealPath(path) {
  // 与「用默认程序打开」走同一条已验证的路径：交给 start，再由 shell 唤起资源管理器。
  // 直接 spawn explorer.exe 在 CREATE_NO_WINDOW 下不生效。
  launch('cmd.exe', ['/c', 'start', '""', 'explorer.exe', '/select,"' + path + '"'], true, true);
}

function openWithDefault(path) {
  launch('cmd.exe', ['/c', 'start', '""', '"' + path + '"'], true);
}

function openInBrowser(path) {
  const url = 'file:///' + path.replace(/\\/g, '/').replace(/ /g, '%20');
  launch('cmd.exe', ['/c', 'start', '""', '"' + url + '"'], true);
}

const DISPATCH = {
  reveal: revealPath,
  open: openWithDefault,
  browser: openInBrowser
};

// ---------------------------------------------------------------- 网址处理

/**
 * 校验一个网页地址。只放行 http/https，且不允许出现双引号（它会被拼进命令行）。
 * @param {unknown} raw
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function resolveUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'url must be a string' };
  const text = raw.trim();
  if (!text) return { ok: false, error: 'url is empty' };
  if (text.length > MAX_PATH_LENGTH) return { ok: false, error: 'url too long' };
  if (text.includes('"')) return { ok: false, error: 'url contains a quote' };
  if (!/^https?:\/\//i.test(text)) return { ok: false, error: 'only http/https is allowed' };

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: 'invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'only http/https is allowed' };
  }
  return { ok: true, url: parsed.toString() };
}

function openExternalUrl(url) {
  // 引号包裹后交给 start，`&` 等 shell 元字符不会被解释
  launch('cmd.exe', ['/c', 'start', '""', '"' + url + '"'], true);
}

// ---------------------------------------------------------------- HTTP

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    const CAP = 64 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > CAP) {
        rejectBody(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolveBody({});
      try {
        resolveBody(JSON.parse(text));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function tailOf(url) {
  const pathname = String(url ?? '').split('?', 1)[0] ?? '';
  if (pathname.startsWith(PREFIX)) return pathname.slice(PREFIX.length);
  return pathname;
}

function makeRoutes() {
  const handler = async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    const tail = tailOf(req.url);
    try {
      if (method === 'GET' && (tail === '/' || tail === '/health')) {
        return json(res, 200, {
          ok: true,
          data: { status: 'ready', actions: [...ACTIONS], cwd: process.cwd() }
        });
      }
      if (method === 'POST' && (tail === '/' || tail === '/exec')) {
        const body = await readJsonBody(req);
        const action = typeof body?.action === 'string' ? body.action : '';
        if (!ACTIONS.has(action)) {
          return json(res, 400, { ok: false, error: 'unknown action: ' + action });
        }
        if (action === 'open-url') {
          const target = resolveUrl(body?.path);
          if (!target.ok) return json(res, 400, { ok: false, error: target.error });
          openExternalUrl(target.url);
          return json(res, 200, { ok: true, data: { action, url: target.url } });
        }
        const target = resolveTarget(body?.path);
        if (!target.ok) return json(res, 400, { ok: false, error: target.error });
        DISPATCH[action](target.path);
        return json(res, 200, { ok: true, data: { action, path: target.path } });
      }
      return json(res, 404, { ok: false, error: 'no route ' + method + ' ' + tail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json(res, 500, { ok: false, error: message });
    }
  };
  return [{ kind: 'prefix', path: PREFIX, handler }];
}

export function apply(ctx) {
  const routes = makeRoutes();
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const disposers = routes.map((route) => httpCtx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'file-actions: routes');
  });
}
