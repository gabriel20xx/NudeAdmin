import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Logger from '../../NudeShared/server/logger/serverLogger.js';
import { initDb } from '../../NudeShared/server/db/db.js';
import { runMigrations } from '../../NudeShared/server/db/migrate.js';
import { query, getDriver } from '../../NudeShared/server/db/db.js';
import session from 'express-session';
import { buildAuthRouter } from '../../NudeShared/server/auth/authRoutes.js';

// Shared integration: expect NudeShared cloned sibling or via env NUDESHARED_DIR
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static: serve admin public and mount shared assets if available
app.use('/static', express.static(path.join(__dirname, 'public')));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Sessions for auth (memory store acceptable for initial dev)
  const sessionSecret = process.env.SESSION_SECRET || 'dev_admin_secret';
  app.use(session({ secret: sessionSecret, resave: false, saveUninitialized: false, cookie: { sameSite: 'lax' } }));

  // Auth routes mounted (signup/login etc.)
  app.use('/auth', buildAuthRouter(express.Router));

// Attempt to mount shared theme & client scripts
const sharedDir = process.env.NUDESHARED_DIR || path.resolve(PROJECT_ROOT, '..', 'NudeShared');
app.use('/shared', express.static(sharedDir));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple locals
app.use((req, res, next) => {
  res.locals.siteTitle = 'NudeAdmin';
  res.locals.currentPath = req.path;
  next();
});

// Routes
app.get('/', (req, res) => res.redirect('/users'));
app.get('/users', (req, res) => { res.render('users', { title: 'Users' }); });
app.get('/media', (req, res) => { res.render('media', { title: 'Media' }); });
app.get('/settings', (req, res) => { res.render('settings', { title: 'Settings' }); });
app.get('/profile', (req, res) => { res.render('profile', { title: 'Profile' }); });

// Health
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --- AuthZ helpers ---
function requireAuth(req, res, next){ if(!req.session?.user?.id) return res.status(401).json({ ok:false, error:'Not authenticated'}); next(); }
function requireAdmin(req,res,next){ const u=req.session?.user; if(!u|| (u.role!=='admin' && u.role!=='superadmin')) return res.status(403).json({ ok:false, error:'Forbidden'}); next(); }

// --- Admin API ---
// Users list with basic filters
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = (req.query.search||'').toString().trim();
    let sql = 'SELECT id,email,username,role,disabled,mfa_enabled as mfaEnabled,created_at as createdAt FROM users';
    const params = [];
    if(search){
      sql += ' WHERE (lower(email) LIKE ? OR lower(username) LIKE ?)';
      const term = `%${search.toLowerCase()}%`;
      params.push(term, term);
    }
    sql += ' ORDER BY id DESC LIMIT 500';
    const result = await query(sql, params);
    res.json({ ok:true, users: result.rows });
  } catch (e) {
    Logger.error('ADMIN_USERS_LIST', e); res.status(500).json({ ok:false, error:'Failed to list users' });
  }
});

// User detail media summary
app.get('/api/admin/users/:id/media', async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(!Number.isFinite(id)) return res.status(400).json({ok:false,error:'Invalid id'});
    const liked = await query('SELECT media_key as mediaKey, created_at as createdAt FROM media_likes WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [id]);
    const saved = await query('SELECT media_key as mediaKey, created_at as createdAt FROM media_saves WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [id]);
    const generated = await query('SELECT media_key as mediaKey, created_at as createdAt FROM media WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [id]);
    res.json({ ok:true, liked: liked.rows, saved: saved.rows, generated: generated.rows });
  }catch(e){ Logger.error('ADMIN_USER_MEDIA', e); res.status(500).json({ok:false,error:'Failed to load user media'}); }
});

// Batch user actions
app.post('/api/admin/users/actions', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { action, ids, role, permissions } = req.body||{};
    if(!Array.isArray(ids) || ids.length===0) return res.status(400).json({ok:false,error:'No ids'});
    const placeholders = ids.map(()=>'?').join(',');
    let done = 0;
    switch(action){
      case 'disable': { const r=await query(`UPDATE users SET disabled=1 WHERE id IN (${placeholders})`, ids); done = r.changes?? r.rowCount ?? 0; break; }
      case 'enable': { const r=await query(`UPDATE users SET disabled=0 WHERE id IN (${placeholders})`, ids); done = r.changes?? r.rowCount ?? 0; break; }
      case 'delete': { const r=await query(`DELETE FROM users WHERE id IN (${placeholders})`, ids); done = r.changes?? r.rowCount ?? 0; break; }
      case 'reset_mfa': { const r=await query(`UPDATE users SET totp_secret=NULL,mfa_enabled=0 WHERE id IN (${placeholders})`, ids); done = r.changes?? r.rowCount ?? 0; break; }
      case 'reset_password': { const r=await query(`UPDATE users SET password_hash='*reset*', password_reset_token=NULL WHERE id IN (${placeholders})`, ids); done = r.changes?? r.rowCount ?? 0; break; }
      case 'change_role': {
        if(!role) return res.status(400).json({ok:false,error:'role required'});
        const r=await query(`UPDATE users SET role=? WHERE id IN (${placeholders})`, [role, ...ids]); done = r.changes?? r.rowCount ?? 0; break; }
      case 'set_permissions': {
        const permStr = JSON.stringify(permissions||{});
        const r=await query(`UPDATE users SET permissions=? WHERE id IN (${placeholders})`, [permStr, ...ids]); done = r.changes?? r.rowCount ?? 0; break; }
      default: return res.status(400).json({ok:false,error:'Unknown action'});
    }
    res.json({ ok:true, action, affected:done });
  }catch(e){ Logger.error('ADMIN_USERS_ACTION', e); res.status(500).json({ok:false,error:'Action failed'}); }
});

// Media listing with category filter
app.get('/api/admin/media', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const cat = (req.query.category||'').toString().trim();
    const search = (req.query.search||'').toString().trim().toLowerCase();
    let where = [];
    const params = [];
    if(cat){ where.push('category=?'); params.push(cat); }
    if(search){ where.push('(lower(title) LIKE ? OR lower(media_key) LIKE ?)'); const term = `%${search}%`; params.push(term, term); }
    let sql = 'SELECT id,media_key as mediaKey,user_id as userId,category,title,active,created_at as createdAt FROM media';
    if(where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const r = await query(sql, params);
    res.json({ ok:true, media:r.rows });
  }catch(e){ Logger.error('ADMIN_MEDIA_LIST', e); res.status(500).json({ok:false,error:'Failed to list media'}); }
});

// Batch media actions
app.post('/api/admin/media/actions', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { action, ids, title, category } = req.body||{};
    if(!Array.isArray(ids) || ids.length===0) return res.status(400).json({ok:false,error:'No ids'});
    const placeholders = ids.map(()=>'?').join(',');
    let done=0;
    switch(action){
      case 'rename': { if(!title) return res.status(400).json({ok:false,error:'title required'}); const r=await query(`UPDATE media SET title=? WHERE id IN (${placeholders})`, [title, ...ids]); done=r.changes?? r.rowCount ?? 0; break; }
      case 'deactivate': { const r=await query(`UPDATE media SET active=0 WHERE id IN (${placeholders})`, ids); done=r.changes?? r.rowCount ?? 0; break; }
      case 'activate': { const r=await query(`UPDATE media SET active=1 WHERE id IN (${placeholders})`, ids); done=r.changes?? r.rowCount ?? 0; break; }
      case 'delete': { const r=await query(`DELETE FROM media WHERE id IN (${placeholders})`, ids); done=r.changes?? r.rowCount ?? 0; break; }
      case 'set_category': { if(!category) return res.status(400).json({ok:false,error:'category required'}); const r=await query(`UPDATE media SET category=? WHERE id IN (${placeholders})`, [category, ...ids]); done=r.changes?? r.rowCount ?? 0; break; }
      default: return res.status(400).json({ok:false,error:'Unknown action'});
    }
    res.json({ ok:true, action, affected: done });
  }catch(e){ Logger.error('ADMIN_MEDIA_ACTION', e); res.status(500).json({ok:false,error:'Action failed'}); }
});

// Settings get
app.get('/api/admin/settings', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const r = await query('SELECT key,value FROM settings');
    const out = {};
    for(const row of r.rows){ out[row.key]= row.value; }
    res.json({ ok:true, settings: out });
  }catch(e){ Logger.error('ADMIN_SETTINGS_GET', e); res.status(500).json({ok:false,error:'Failed to load settings'}); }
});

// Settings update (batch)
app.post('/api/admin/settings', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const updates = req.body||{};
    const entries = Object.entries(updates).slice(0,100);
    for(const [k,v] of entries){
      // Upsert style
      if(getDriver()==='pg'){
        await query('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()', [k,String(v)]);
      } else {
        await query('INSERT INTO settings(key,value,updated_at) VALUES(?,?,datetime("now")) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime("now")', [k,String(v)]);
      }
    }
    res.json({ ok:true, updated: entries.length });
  }catch(e){ Logger.error('ADMIN_SETTINGS_SET', e); res.status(500).json({ok:false,error:'Failed to update settings'}); }
});

// Initialize DB/migrations on startup
(async ()=>{
  try { await initDb(); await runMigrations(); Logger.info('NUDEADMIN','DB ready'); } catch(e){ Logger.error('NUDEADMIN','DB init failed', e); }
})();

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => {
  console.log(`[nudeadmin] listening on port ${PORT}`);
});
