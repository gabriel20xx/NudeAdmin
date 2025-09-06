import assert from 'assert';
import http from 'http';
import { app } from '../src/app.js';
import { query } from '../../NudeShared/server/db/db.js';

function req(method, urlStr, data, headers={}){
  return new Promise((resolve,reject)=>{
    const u = new URL(urlStr);
    const body = data ? JSON.stringify(data) : null;
    const req = http.request({hostname:u.hostname, port:u.port, path:u.pathname+(u.search||''), method, headers:{ 'Content-Type':'application/json', ...(body? {'Content-Length':Buffer.byteLength(body)}:{}), ...headers }}, res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>{ res.body = Buffer.concat(chunks).toString('utf8'); resolve(res); });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const testEmail = `admin${Date.now()}@example.com`;

  // Signup test user with unique email to avoid 409 on reruns
  let cookie;
  {
    const res = await req('POST', base + '/auth/signup', { email:testEmail, password:'secret123' });
    assert.strictEqual(res.statusCode, 200, 'signup 200');
    cookie = res.headers['set-cookie']?.[0]?.split(';')[0];
    assert.ok(cookie, 'signup sets cookie');
  }

  // Promote to admin directly via DB
  {
    await query('UPDATE users SET role = ? WHERE email = ?', ['admin', testEmail]);
  }

  // Re-login to refresh session user object with role
  {
    const res = await req('POST', base + '/auth/login', { email:testEmail, password:'secret123' }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'relogin 200');
    // keep existing cookie if not new
    cookie = res.headers['set-cookie']?.[0]?.split(';')[0] || cookie;
  }

  // Access users list (should now 200)
  {
    const res = await req('GET', base + '/api/admin/users', null, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'admin users 200');
    const js = JSON.parse(res.body); assert.ok(js.users || js.success, 'users payload');
  }

  // Settings GET (should empty or object)
  {
    const res = await req('GET', base + '/api/admin/settings', null, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'settings get 200');
  }

  // Settings POST
  {
    const res = await req('POST', base + '/api/admin/settings', { example_key:'value1' }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'settings post 200');
  }

  // Multi-settings POST
  {
    const res = await req('POST', base + '/api/admin/settings', { feature_flag:'on', ui_theme:'dark' }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'multi settings post 200');
  }

  // Media list (likely empty) still 200
  {
    const res = await req('GET', base + '/api/admin/media', null, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'media list 200');
  }

  // Batch user action: change_role (self -> superadmin)
  let userId;
  {
    const res = await req('GET', base + '/api/admin/users', null, { Cookie: cookie });
    const js = JSON.parse(res.body); userId = js.users?.[0]?.id;
  }
  if(userId){
    const res = await req('POST', base + '/api/admin/users/actions', { action:'change_role', ids:[userId], role:'superadmin' }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'change_role 200');
  }

  // Batch user action: set_permissions
  if(userId){
    const res = await req('POST', base + '/api/admin/users/actions', { action:'set_permissions', ids:[userId], permissions:{ beta:true } }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'set_permissions 200');
  }

  console.log('NudeAdmin auth/admin flow tests passed');
  server.close();
})();
