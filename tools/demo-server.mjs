// The local demo site for `npm run demo`:
//
//   node tools/demo-server.mjs        http://127.0.0.1:5179/demo/index.html
//
// It serves the files in demo/ and nothing else: not src/config.js (the App
// Check debug token), not tools/*.local.txt, not .git. It answers only
// requests addressed to this computer by name (127.0.0.1 or localhost), so
// a web page whose own address points here cannot read it either.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 5179;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** The files the demo may serve: the plain files directly in `dir`, by name. */
async function allowlist(dir) {
  const names = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('.') && TYPES[path.extname(entry.name).toLowerCase()]) {
      names.set(entry.name, path.join(dir, entry.name));
    }
  }
  return names;
}

/**
 * A server for the demo/ folder of `root`, at /demo/<file>. The list of
 * files is read once, at start: anything else is 404.
 */
export function createDemoServer({ root = ROOT } = {}) {
  return createFolderServer(path.join(root, 'demo'), '/demo/');
}

/**
 * A server for the plain files directly in `dir`, at `prefix`<file> (a path
 * such as '/demo/'), to this computer only, as above. The list of files is
 * read once, at start: anything else is 404. test/probe/run.mjs serves
 * dist/probe with it.
 */
export async function createFolderServer(dir, prefix) {
  const files = await allowlist(dir);
  const start = `${prefix}index.html`;
  return http.createServer(async (request, response) => {
    const send = (status, text, headers = {}) => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
      response.end(request.method === 'HEAD' ? undefined : text);
    };
    // Only this computer, by name: a page whose address only resolves here is refused.
    const port = request.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(String(request.headers.host || '').toLowerCase())) return send(421, 'Wrong host');
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'Method not allowed', { allow: 'GET, HEAD' });

    const pathname = String(request.url || '').split(/[?#]/)[0];
    if (pathname === '/' || pathname === prefix || pathname === prefix.slice(0, -1)) {
      return send(302, 'Found', { location: start });
    }
    // One plain file name right after the prefix, nothing encoded, no folders.
    const name = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
    const file = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[a-z]+$/.test(name) ? files.get(name) : undefined;
    if (!file) return send(404, 'Not found');
    try {
      const info = await stat(file);
      response.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()],
        'content-length': info.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      if (request.method === 'HEAD') return response.end();
      createReadStream(file).pipe(response);
    } catch {
      send(404, 'Not found');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await createDemoServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Demo: http://127.0.0.1:${PORT}/demo/index.html (only the files in demo/)`);
  });
}
