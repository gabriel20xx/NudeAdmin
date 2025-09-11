import express from 'express';
import path from 'path';
import fs from 'fs';
import { mountTheme } from '../../NudeShared/server/theme/mountTheme.js';
import { mountSharedStatic, defaultSharedCandidates, registerCachePolicyEndpoint } from '../../NudeShared/server/index.js';
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
import { getOrCreateOutputThumbnail } from './services/thumbnails.js';

// Shared integration: expect NudeShared cloned sibling or via env NUDESHARED_DIR
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const app = express();
// Align with NudeForge: use strong ETags for consistent conditional GET behavior
app.set('etag', 'strong');
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

// Shared static assets (tiered caching)
const sharedDir = process.env.NUDESHARED_DIR || path.resolve(PROJECT_ROOT, '..', 'NudeShared');
mountSharedStatic(app, { candidates: [sharedDir], logger: Logger });

// Unified theme mount
mountTheme(app, { projectDir: path.join(__dirname), sharedDir, logger: console });

// Expose generated media output directory and a lightweight thumbnail passthrough for Admin previews
// NOTE: We intentionally resolve OUTPUT_DIR lazily for routes to allow tests to override
// process.env.OUTPUT_DIR after the module is first imported.
function resolveOutputDir(){
  const envDir = process.env.OUTPUT_DIR;
  if (envDir) return path.resolve(envDir);
  return path.resolve(WORKSPACE_ROOT, 'output');
}
const OUTPUT_DIR = resolveOutputDir(); // still used for static mount (non-dynamic)

// Serve original generated files
app.use('/output', express.static(OUTPUT_DIR));

// Resized thumbnail handler with caching under OUTPUT_DIR/.thumbs
app.get('/thumbs/output/:rest(*)', async (req, res) => {
  try {
    const currentOutputDir = resolveOutputDir();
    const rest = String(req.params.rest || '');
    const normalized = path.normalize(rest).replace(/^\.+[\\\/]?/, '').replace(/^[\\\/]+/, '');
    const abs = path.join(currentOutputDir, normalized);
    const rel = path.relative(currentOutputDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).send('Invalid path');
    if (!fs.existsSync(abs)) {
      Logger.warn('ADMIN_THUMBS', 'Original file missing', { abs, outputDir: currentOutputDir, normalized });
      return res.status(404).send('Not found');
    }
    const w = Number(req.query.w) || undefined;
    const h = Number(req.query.h) || undefined;
    const filePath = await getOrCreateOutputThumbnail(currentOutputDir, normalized, { w, h });
    res.set({ 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'image/jpeg' });
    return res.sendFile(filePath);
  } catch (e) {
    Logger.error('ADMIN_THUMBS', 'Error serving output thumbnail:', e);
    return res.status(404).send('Thumbnail not available');
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Admin bootstrap aware locals (enables signup ONLY when no admin exists) ---
let adminPresenceCache = { hasAdmin: null, ts: 0 };
async function ensureAdminPresenceFlag(){
  const now = Date.now();
  if (adminPresenceCache.ts && (now - adminPresenceCache.ts) < 5000 && adminPresenceCache.hasAdmin !== null) return adminPresenceCache.hasAdmin;
  try {
    const { rows } = await query("SELECT 1 FROM users WHERE role IN ('admin','superadmin') LIMIT 1", []);
    adminPresenceCache = { hasAdmin: !!(rows && rows.length), ts: Date.now() };
  } catch { adminPresenceCache = { hasAdmin: true, ts: Date.now() }; }
  return adminPresenceCache.hasAdmin;
}
// Immediate cache invalidation when first admin is created (event emitted in authRoutes.js)
try {
  process.on('nudeplatform:first-admin-created', () => {
    adminPresenceCache = { hasAdmin: true, ts: Date.now() };
  });
} catch {}
app.use(async (req, res, next) => {
  const hasAdmin = await ensureAdminPresenceFlag();
  const adminNeeded = !hasAdmin;
  res.locals.siteTitle = 'NudeAdmin';
  res.locals.currentPath = req.path;
  // Disable signup AFTER first admin created; enable when bootstrapping first admin
  res.locals.disableSignup = !adminNeeded ? true : false;
  res.locals.appCssHref = '';
  res.locals.enableSocketIO = false;
  res.locals.lockAuthClose = true; // keep modal from closing on accidental outside click
  res.locals.isAuthenticated = !!(req.session?.user?.id);
  res.locals.user = req.session?.user || null;
  // Expose bootstrap flag for potential conditional copy (not strictly required for overlay logic)
  res.locals.adminNeeded = adminNeeded;
  next();
});

// Auth gate middleware – allow auth endpoints & health without session
function authGate(req, res, next){
  if (req.session?.user?.id) return next();
  // Allow unauthenticated access to auth endpoints, static assets, health probes, cache policy introspection, socket.io, and APIs
  if (req.path.startsWith('/auth') || req.path.startsWith('/static') || req.path.startsWith('/shared') || req.path.startsWith('/health') || req.path.startsWith('/__cache-policy') || req.path.startsWith('/socket.io') || req.path.startsWith('/api')) {
    return next();
  }
  // Render unified shared layout page that auto-opens auth modal
  return res.status(200).render('auth-required', { title: 'Authenticate' });
}
app.use(authGate);

// Routes (protected by authGate)
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => { res.render('dashboard', { title: 'Dashboard' }); });
// Stats API for dashboard
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { period = '7d', filter = '' } = req.query || {};
    const driver = getDriver();
    const getDateCond = (col) => {
      if (String(period) === 'all') return { sql: '', params: [] };
      if (driver === 'pg') {
        const days = String(period) === '30d' ? 30 : 7;
        return { sql: ` AND ${col} >= NOW() - INTERVAL '${days} days'`, params: [] };
      }
      // sqlite
      const days = String(period) === '30d' ? 30 : 7;
      return { sql: ` AND ${col} >= datetime('now', '-${days} days')`, params: [] };
    };
    const normFilter = String(filter || '').trim();
    const hasFilter = normFilter.length > 0;
    const likeValPg = `%${normFilter}%`;
    const likeValSqlite = `%${normFilter.toLowerCase()}%`;
    const likeExpr = (col) => driver === 'pg' ? `${col} ILIKE $X` : `LOWER(${col}) LIKE ?`;

    // Totals: users
    {
      let sql = 'SELECT COUNT(1) AS c FROM users WHERE 1=1';
      const params = [];
      const dt = getDateCond('created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') {
          sql += ` AND (email ILIKE $1 OR username ILIKE $2)`;
          params.push(likeValPg, likeValPg);
        } else {
          sql += ` AND (LOWER(email) LIKE ? OR LOWER(username) LIKE ?)`;
          params.push(likeValSqlite, likeValSqlite);
        }
      }
      var { rows: u } = await query(sql, params);
    }

    // Totals: media generated
    {
      let sql = 'SELECT COUNT(1) AS c FROM media m LEFT JOIN users u ON u.id = m.user_id WHERE 1=1';
      const params = [];
      const dt = getDateCond('m.created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') {
          sql += ` AND (m.media_key ILIKE $1 OR u.email ILIKE $2 OR u.username ILIKE $3)`;
          params.push(likeValPg, likeValPg, likeValPg);
        } else {
          sql += ` AND (LOWER(m.media_key) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ?)`;
          params.push(likeValSqlite, likeValSqlite, likeValSqlite);
        }
      }
      var { rows: m } = await query(sql, params);
    }

    // Totals: views
    {
      let sql = 'SELECT COUNT(1) AS c FROM media_views t LEFT JOIN users u ON u.id = t.user_id WHERE 1=1';
      const params = [];
      const dt = getDateCond('t.created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') {
          sql += ` AND (t.media_key ILIKE $1 OR u.email ILIKE $2 OR u.username ILIKE $3)`;
          params.push(likeValPg, likeValPg, likeValPg);
        } else {
          sql += ` AND (LOWER(t.media_key) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ?)`;
          params.push(likeValSqlite, likeValSqlite, likeValSqlite);
        }
      }
      var { rows: v } = await query(sql, params);
    }

    // Totals: downloads
    {
      let sql = 'SELECT COUNT(1) AS c FROM media_downloads t LEFT JOIN users u ON u.id = t.user_id WHERE 1=1';
      const params = [];
      const dt = getDateCond('t.created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') {
          sql += ` AND (t.media_key ILIKE $1 OR u.email ILIKE $2 OR u.username ILIKE $3)`;
          params.push(likeValPg, likeValPg, likeValPg);
        } else {
          sql += ` AND (LOWER(t.media_key) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ?)`;
          params.push(likeValSqlite, likeValSqlite, likeValSqlite);
        }
      }
      var { rows: d } = await query(sql, params);
    }

    // Leader: top user by generations
    let topUserRows;
    {
      let sql = `SELECT u.id, COALESCE(u.username, u.email) AS name, COUNT(m.id) AS count
                 FROM media m LEFT JOIN users u ON u.id = m.user_id
                 WHERE 1=1`;
      const params = [];
      const dt = getDateCond('m.created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') {
          sql += ` AND (m.media_key ILIKE $1 OR u.email ILIKE $2 OR u.username ILIKE $3)`;
          params.push(likeValPg, likeValPg, likeValPg);
        } else {
          sql += ` AND (LOWER(m.media_key) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ?)`;
          params.push(likeValSqlite, likeValSqlite, likeValSqlite);
        }
      }
      sql += ' GROUP BY u.id, name ORDER BY count DESC LIMIT 1';
      const { rows } = await query(sql, params);
      topUserRows = rows;
    }

    async function mediaLeader(tableName){
      let sql = `SELECT t.media_key, COUNT(1) AS count
                 FROM ${tableName} t LEFT JOIN users u ON u.id = t.user_id
                 WHERE 1=1`;
      const params = [];
      const dt = getDateCond('t.created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') {
          sql += ` AND (t.media_key ILIKE $1 OR u.email ILIKE $2 OR u.username ILIKE $3)`;
          params.push(likeValPg, likeValPg, likeValPg);
        } else {
          sql += ` AND (LOWER(t.media_key) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ?)`;
          params.push(likeValSqlite, likeValSqlite, likeValSqlite);
        }
      }
      sql += ' GROUP BY t.media_key ORDER BY count DESC LIMIT 1';
      const { rows } = await query(sql, params);
      return rows?.[0] || null;
    }

    const [mostViews, mostLikes, mostSaves, mostDownloads] = await Promise.all([
      mediaLeader('media_views'), mediaLeader('media_likes'), mediaLeader('media_saves'), mediaLeader('media_downloads')
    ]);

    // Generation time metrics (avg, min, max with media preview)
    let avgGenMs = null, minGen = null, maxGen = null;
    {
      // average
      let sql = 'SELECT AVG(elapsed_ms) AS avg_ms FROM media_metrics WHERE 1=1';
      const params = [];
      const dt = getDateCond('created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') {
          sql += ' AND media_key ILIKE $1'; params.push(likeValPg);
        } else { sql += ' AND LOWER(media_key) LIKE ?'; params.push(likeValSqlite); }
      }
      const { rows } = await query(sql, params);
      avgGenMs = rows?.[0]?.avg_ms != null ? Math.round(Number(rows[0].avg_ms)) : null;
    }
    // min
    {
      let sql = 'SELECT media_key, elapsed_ms FROM media_metrics WHERE 1=1';
      const params = [];
      const dt = getDateCond('created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') { sql += ' AND media_key ILIKE $1'; params.push(likeValPg); }
        else { sql += ' AND LOWER(media_key) LIKE ?'; params.push(likeValSqlite); }
      }
      sql += ' ORDER BY elapsed_ms ASC LIMIT 1';
      const { rows } = await query(sql, params);
      minGen = rows?.[0] || null;
    }
    // max
    {
      let sql = 'SELECT media_key, elapsed_ms FROM media_metrics WHERE 1=1';
      const params = [];
      const dt = getDateCond('created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') { sql += ' AND media_key ILIKE $1'; params.push(likeValPg); }
        else { sql += ' AND LOWER(media_key) LIKE ?'; params.push(likeValSqlite); }
      }
      sql += ' ORDER BY elapsed_ms DESC LIMIT 1';
      const { rows } = await query(sql, params);
      maxGen = rows?.[0] || null;
    }

    // Conversion rates (likes/views, saves/views, downloads/views)
    let conv = { likeRate: null, saveRate: null, downloadRate: null };
    {
      // counts in window
      async function countOf(table){
        let sql = `SELECT COUNT(1) AS c FROM ${table} WHERE 1=1`;
        const params = [];
        const dt = getDateCond('created_at');
        sql += dt.sql;
        if (hasFilter) {
          if (driver === 'pg') { sql += ' AND media_key ILIKE $1'; params.push(likeValPg); }
          else { sql += ' AND LOWER(media_key) LIKE ?'; params.push(likeValSqlite); }
        }
        const { rows } = await query(sql, params);
        return Number(rows?.[0]?.c || 0);
      }
      const [vc, lc, sc, dc] = await Promise.all([
        countOf('media_views'), countOf('media_likes'), countOf('media_saves'), countOf('media_downloads')
      ]);
      const safeDiv = (a,b)=> b>0? (a/b) : null;
      conv.likeRate = safeDiv(lc, vc);
      conv.saveRate = safeDiv(sc, vc);
      conv.downloadRate = safeDiv(dc, vc);
    }

    // Longest single view session duration (media_view_sessions)
    let longestView = null;
    {
      let sql = 'SELECT media_key, duration_ms FROM media_view_sessions WHERE 1=1';
      const params = [];
      const dt = getDateCond('created_at');
      sql += dt.sql;
      if (hasFilter) {
        if (driver === 'pg') { sql += ' AND media_key ILIKE $1'; params.push(likeValPg); }
        else { sql += ' AND LOWER(media_key) LIKE ?'; params.push(likeValSqlite); }
      }
      sql += ' ORDER BY duration_ms DESC LIMIT 1';
      const { rows } = await query(sql, params);
      longestView = rows?.[0] || null;
    }

    res.json({
      success:true,
      totals: {
        users: Number(u?.[0]?.c||0),
        generated: Number(m?.[0]?.c||0),
        viewed: Number(v?.[0]?.c||0),
        downloads: Number(d?.[0]?.c||0)
      },
      leaders: {
        topUser: topUserRows?.[0] || null,
        mostViews,
        mostLikes,
        mostSaves,
        mostDownloads
      },
      metrics: {
        avgGenMs,
        minGen,
        maxGen,
  conversion: conv,
  longestView
      }
    });
  }catch(e){ Logger.error('ADMIN_STATS', e); res.status(500).json({ success:false, error:'Failed to load stats' }); }
});
app.get('/users', (req, res) => { res.render('users', { title: 'Users' }); });
app.get('/media', (req, res) => { res.render('media', { title: 'Media' }); });
app.get('/settings', (req, res) => { res.render('settings', { title: 'Settings' }); });
app.get('/profile', (req, res) => { res.render('profile', { title: 'Profile' }); });

// Health
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Cache policy endpoint via shared helper
registerCachePolicyEndpoint(app, {
  service: 'NudeAdmin',
  getPolicies: () => ({
    shared: {
      cssJs: 'public, max-age=3600',
      images: 'public, max-age=86400, stale-while-revalidate=604800'
    },
    thumbnails: 'public, max-age=86400',
    output: 'default (express static – adjust if needed)',
    themeCss: 'public, max-age=3600'
  }),
  note: 'Adjust caching logic in app.js if changing policies. This endpoint is informational.'
});

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

// --- Test Helpers ---
// Lightweight app exposing only thumbnail route for isolated testing without full admin initialization.
export function buildThumbnailTestApp(outputDir){
  const tApp = express();
  function safeOutputDir(){ return outputDir || resolveOutputDir(); }
  tApp.get('/thumbs/output/:rest(*)', async (req, res) => {
    try {
      const currentOutputDir = safeOutputDir();
      const rest = String(req.params.rest || '');
      const normalized = path.normalize(rest).replace(/^\.+[\\\/]?/, '').replace(/^[\\\/]+/, '');
      const abs = path.join(currentOutputDir, normalized);
      const rel = path.relative(currentOutputDir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).send('Invalid path');
      if (!fs.existsSync(abs)) return res.status(404).send('Not found');
      const w = Number(req.query.w) || undefined;
      const h = Number(req.query.h) || undefined;
      const filePath = await getOrCreateOutputThumbnail(currentOutputDir, normalized, { w, h });
      res.set({ 'Cache-Control': 'public, max-age=60', 'Content-Type': 'image/jpeg' });
      return res.sendFile(filePath);
    } catch (e) {
      return res.status(404).send('Thumbnail not available');
    }
  });
  return tApp;
}
