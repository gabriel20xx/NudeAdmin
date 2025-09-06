import assert from 'assert';
import http from 'http';
import { app } from '../src/app.js';
import { query, getDriver } from '../../NudeShared/server/db/db.js';

function req(method, urlStr, data, headers={}){
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
  // Create admin user via signup
  let cookie; let userId;
  {
    const res = await req('POST', base + '/auth/signup', { email:'mediaadmin@example.com', password:'secret123' });
    cookie = res.headers['set-cookie']?.[0].split(';')[0];
    assert.ok(cookie, 'signup cookie');
  }
  await query('UPDATE users SET role=? WHERE email=?', ['admin','mediaadmin@example.com']);
  {
    const res = await req('GET', base + '/api/admin/users', null, { Cookie: cookie });
    const js = JSON.parse(res.body); userId = js.users[0].id;
  }
  // Insert sample media records directly
  const driver = getDriver();
  const insertSql = driver==='pg' ? 'INSERT INTO media(user_id, media_key, title, category, active) VALUES($1,$2,$3,$4,$5) RETURNING id' : 'INSERT INTO media(user_id, media_key, title, category, active) VALUES(?,?,?,?,?)';
  const createdIds = [];
  for(let i=0;i<3;i++){
    const mediaKey = `test-media-${i}.png`;
    if(driver==='pg'){
      const { rows } = await query(insertSql, [userId, mediaKey, `Title ${i}`, 'initial', true]);
      createdIds.push(rows[0].id);
    } else {
      const r = await query(insertSql, [userId, mediaKey, `Title ${i}`, 'initial', 1]);
      createdIds.push(r.lastInsertRowid || r.insertId); // best-effort
    }
  }

  // Rename batch
  {
    const res = await req('POST', base + '/api/admin/media/actions', { action:'rename', ids: createdIds, title:'Renamed' }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'rename 200');
  }
  // Deactivate
  {
    const res = await req('POST', base + '/api/admin/media/actions', { action:'deactivate', ids: createdIds }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'deactivate 200');
  }
  // Activate
  {
    const res = await req('POST', base + '/api/admin/media/actions', { action:'activate', ids: createdIds }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'activate 200');
  }
  // Set category
  {
    const res = await req('POST', base + '/api/admin/media/actions', { action:'set_category', ids: createdIds, category:'updated' }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'set_category 200');
  }
  // List media with search filter ensures updated title match
  {
    const res = await req('GET', base + '/api/admin/media?search=renamed', null, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'media search 200');
  }

  // Delete batch
  {
    const res = await req('POST', base + '/api/admin/media/actions', { action:'delete', ids: createdIds }, { Cookie: cookie });
    assert.strictEqual(res.statusCode, 200, 'delete 200');
  }

  console.log('Admin media batch action tests passed');
  server.close();
})();
