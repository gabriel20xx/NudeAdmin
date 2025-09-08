import express from 'express';
import path from 'path';
import fs from 'fs';
import { mountTheme } from '../../NudeShared/server/theme/mountTheme.js';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Logger from '../../NudeShared/server/logger/serverLogger.js';
import { initDb } from '../../NudeShared/server/db/db.js';
import { runMigrations } from '../../NudeShared/server/db/migrate.js';
import { query, getDriver } from '../../NudeShared/server/db/db.js';
import session from 'express-session';
import { buildAuthRouter } from '../../NudeShared/server/api/authRoutes.js';
import { buildUsersAdminRouter } from '../../NudeShared/server/api/usersRoutes.js';
import { buildAdminMediaRouter } from '../../NudeShared/server/api/adminMediaRoutes.js';
import { buildAdminSettingsRouter } from '../../NudeShared/server/api/adminSettingsRoutes.js';
import { buildAdminUsersRouter } from '../../NudeShared/server/api/adminUsersRoutes.js';

// Shared integration: expect NudeShared cloned sibling or via env NUDESHARED_DIR
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Minimal layout helper to support `<% layout('partials/layout') %>` in views
// Usage in a view: `<% layout('partials/layout') %>` then the template's body will be exposed as `body` inside the layout file.
app.use((req, res, next) => {
  res.locals.__layout = null;
  res.locals.layout = function(layoutPath){ res.locals.__layout = layoutPath; };
  // Wrap render to inject body into layout if requested
  const origRender = res.render.bind(res);
  res.render = function(view, options = {}, callback){
    // First render original view to string
    return origRender(view, { ...res.locals, ...options }, function(err, html){
      if (err) return callback ? callback(err) : req.next(err);
      if (!res.locals.__layout) {
        return callback ? callback(null, html) : res.send(html);
      }
      const bodyHtml = html;
      const layoutView = res.locals.__layout;
      // Prevent recursive layout usage inside layout itself
      const layoutLocals = { ...res.locals, ...options, body: bodyHtml };
      res.locals.__layout = null; // reset
      return origRender(layoutView, layoutLocals, callback ? callback : function(lErr, lHtml){
        if (lErr) return req.next(lErr);
        res.send(lHtml);
      });
    });
  };
  next();
});

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

// Unified theme mount
mountTheme(app, { projectDir: path.join(__dirname), sharedDir, logger: console });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple locals
app.use((req, res, next) => {
  res.locals.siteTitle = 'NudeAdmin';
  res.locals.currentPath = req.path;
  // Disable signup in shared header for admin panel
  res.locals.disableSignup = true;
  next();
});

// Auth gate middleware – allow auth endpoints & health without session
function authGate(req, res, next){
  if (req.session?.user?.id) return next();
  // Allow login endpoints, static assets, health, and socket.io
  if (req.path.startsWith('/auth') || req.path.startsWith('/static') || req.path.startsWith('/shared') || req.path.startsWith('/health') || req.path.startsWith('/socket.io')) {
    return next();
  }
  // Render login page (minimal layout) – supply flag for header
  return res.status(200).render('login', { title: 'Admin Login', isLoginPage: true });
}
app.use(authGate);

// Routes (protected by authGate)
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

// Shared Users Admin API (users listing & media summary)
app.use('/api', buildUsersAdminRouter({
  requireAuth,
  requireAdmin,
  utils: {
    success: (data,message='OK')=>({success:true,data,message}),
    error: (e)=>({success:false,error:e}),
    infoLog: (...a)=>Logger.info('ADMIN_SHARED',...a),
    errorLog: (...a)=>Logger.error('ADMIN_SHARED',...a)
  },
  basePath: '/admin'
}));
// New consolidated admin users router (list, media summary, batch actions)
app.use('/api', buildAdminUsersRouter({
  requireAuth,
  requireAdmin,
  utils: {
    success: (data,message='OK')=>({success:true,data,message}),
    error: (e)=>({success:false,error:e}),
    infoLog: (...a)=>Logger.info('ADMIN_USERS_SHARED',...a),
    errorLog: (...a)=>Logger.error('ADMIN_USERS_SHARED',...a)
  },
  basePath: '/admin'
}));
// Shared Admin Media batch/list endpoints
app.use('/api', buildAdminMediaRouter({
  requireAuth,
  requireAdmin,
  utils: {
    success: (data,message='OK')=>({success:true,data,message}),
    error: (e)=>({success:false,error:e}),
    infoLog: (...a)=>Logger.info('ADMIN_MEDIA_SHARED',...a),
    errorLog: (...a)=>Logger.error('ADMIN_MEDIA_SHARED',...a)
  },
  basePath: '/admin'
}));
// Shared Admin Settings endpoints
app.use('/api', buildAdminSettingsRouter({
  requireAuth,
  requireAdmin,
  utils: {
    success: (data,message='OK')=>({success:true,data,message}),
    error: (e)=>({success:false,error:e}),
    infoLog: (...a)=>Logger.info('ADMIN_SETTINGS_SHARED',...a),
    errorLog: (...a)=>Logger.error('ADMIN_SETTINGS_SHARED',...a)
  },
  basePath: '/admin'
}));


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


// Initialize DB/migrations on startup
(async ()=>{
  try { await initDb(); await runMigrations(); Logger.info('NUDEADMIN','DB ready'); } catch(e){ Logger.error('NUDEADMIN','DB init failed', e); }
})();

const PORT = process.env.PORT || 8090;
// Only start server if this file is the entrypoint (not when imported for tests)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  app.listen(PORT, () => {
    console.log(`[nudeadmin] listening on port ${PORT}`);
  });
}

export { app };
