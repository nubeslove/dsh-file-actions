// dsh-file-actions — host 侧
// 职责：为 Web 客户端提供「对本地文件执行系统动作」的受限接口。
// 只允许三个动作：在资源管理器中定位、用默认程序打开、用浏览器打开。
// 所有路径在执行前做存在性校验；不接受任意命令，不接受 shell 解释。
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

export const name = 'file-actions';
export const inject = [];

const PREFIX = '/api/file-actions';
const MAX_PATH_LENGTH = 4096;

const ACTIONS = new Set(['reveal', 'open', 'browser']);

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
 */
function launch(command, args, verbatim) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: verbatim === true
  });
  child.unref();
}

function revealPath(path) {
  launch('explorer.exe', ['/select,"' + path + '"'], true);
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
