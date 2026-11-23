import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/results') {
      let body = ''; for await (const part of req) { body += part; if (body.length > 20000) throw new Error('Too large'); }
      const result = JSON.parse(body);
      await mkdir(new URL('logs/', root), { recursive: true });
      await writeFile(new URL('logs/speed-verification.local.json', root), JSON.stringify(result, null, 2));
      res.end('ok'); return;
    }
    const file = req.url === '/' ? new URL('scripts/speed-fixture.html', root) : req.url === '/helper.js' ? new URL('mooc-helper.user.js', root) : null;
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    res.end(await readFile(file));
  } catch { res.writeHead(500); res.end('Verification server error'); }
}).listen(17364, '127.0.0.1', () => console.log(`倍速实播验证：http://127.0.0.1:17364\n结果：${fileURLToPath(new URL('logs/speed-verification.local.json', root))}`));
