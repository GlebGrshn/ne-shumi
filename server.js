// Локальный статический сервер для отладки (Яндекс SDK при этом работает в mock-режиме).
// Для теста с настоящим SDK: npx @yandex-games/sdk-dev-proxy -p 5173
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 5173;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // отладка: POST /shot принимает dataURL и пишет screenshot.jpg рядом
  if (req.method === 'POST' && urlPath === '/shot') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const name = (q.get('name') || 'screenshot').replace(/[^a-z0-9_-]/gi, '');
    const dir = q.get('dir') === 'store' ? path.join(ROOT, 'store') : ROOT;
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const b64 = body.replace(/^data:image\/\w+;base64,/, '');
        fs.mkdirSync(dir, { recursive: true });
        const ext = /^data:image\/png/.test(body) ? '.png' : '.jpg';
        fs.writeFileSync(path.join(dir, name + ext), Buffer.from(b64, 'base64'));
        res.writeHead(200); res.end('ok');
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('http://localhost:' + PORT));
