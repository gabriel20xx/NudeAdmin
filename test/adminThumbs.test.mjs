import assert from 'assert';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

function rawRequest(method, urlStr){
  return new Promise((resolve,reject)=>{
    const u = new URL(urlStr);
    const req = http.request({ hostname:u.hostname, port:u.port, path:u.pathname + (u.search||''), method }, res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>{
        res.buffer = Buffer.concat(chunks);
        resolve(res);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // Prepare isolated OUTPUT_DIR with a mock image
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nudeadmin-out-'));
  process.env.OUTPUT_DIR = tmpBase;

  const inputPng = path.join(tmpBase, 'sample.png');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .png()
    .toFile(inputPng);

  // Import app after setting OUTPUT_DIR so it picks up the env
  const { app } = await import('../src/app.js');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // Hit thumbnail route with width param
  const res = await rawRequest('GET', base + '/thumbs/output/sample.png?w=200');
  assert.strictEqual(res.statusCode, 200, 'thumb route should return 200');
  assert.match(String(res.headers['content-type']||''), /image\/jpeg/i, 'content-type should be image/jpeg');
  assert.ok(res.buffer && res.buffer.length > 100, 'thumbnail bytes should be returned');

  // Cache file should exist
  const cached = path.join(tmpBase, '.thumbs', 'sample.jpg');
  assert.ok(fs.existsSync(cached), 'cached thumbnail exists');

  console.log('Admin thumbnail route test passed');
  server.close();

  // Cleanup best-effort
  try { await fs.promises.rm(tmpBase, { recursive: true, force: true }); } catch {}
})();
