import assert from 'assert';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { app } from '../src/app.js';

function request(method, urlStr, data){
  return new Promise((resolve,reject)=>{
    const u = new URL(urlStr);
    const body = data ? JSON.stringify(data) : null;
    const req = http.request({ hostname:u.hostname, port:u.port, path:u.pathname + (u.search||''), method, headers: { 'Content-Type':'application/json', 'Content-Length': body? Buffer.byteLength(body):0 }}, res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>{ res.body = Buffer.concat(chunks).toString('utf8'); resolve(res); });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

(async () => {
  // Start ephemeral server
  const server = app.listen(0);
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  // Health check
  {
    const res = await request('GET', base + '/health');
    assert.strictEqual(res.statusCode, 200, 'health 200');
  }

  // Attempt users list without session (should 401)
  {
    const res = await request('GET', base + '/api/admin/users');
    assert.strictEqual(res.statusCode, 401, 'users list unauth 401');
  }

  // Attempt media list without session (should 401)
  {
    const res = await request('GET', base + '/api/admin/media');
    assert.strictEqual(res.statusCode, 401, 'media list unauth 401');
  }

  console.log('NudeAdmin shared admin route basic tests passed');
  server.close();
})();
