import assert from 'assert';
import http from 'http';
import { app } from '../src/app.js';
import { query } from '../../NudeShared/server/db/db.js';

function request(method, urlStr, data, headers={}){
  return new Promise((resolve,reject)=>{
    const u = new URL(urlStr);
    const body = data ? JSON.stringify(data) : null;
    const req = http.request({hostname:u.hostname, port:u.port, path:u.pathname+(u.search||''), method, headers:{ 'Content-Type':'application/json', ...(body? {'Content-Length':Buffer.byteLength(body)}:{}), ...headers }}, res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>{ res.body = Buffer.concat(chunks).toString('utf8'); resolve(res); });
    });
    req.on('error', reject); if(body) req.write(body); req.end();
  });
}

(async () => {
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  let cookie; let userId;
  // signup
  {
    const res = await request('POST', base + '/auth/signup', { email:'mediauser@example.com', password:'secret123' });
    cookie = res.headers['set-cookie']?.[0].split(';')[0];
  }
  // promote
  await query('UPDATE users SET role=? WHERE email=?', ['admin','mediauser@example.com']);
  // fetch users list
  {
    const res = await request('GET', base + '/api/admin/users', null, { Cookie: cookie });
    const js = JSON.parse(res.body); userId = js.users[0].id;
  }
  // summary
  {
    const res = await request('GET', base + `/api/admin/users/${userId}/media`, null, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'media summary 200');
  }
  server.close();
})();
