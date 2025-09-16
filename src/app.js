import express from 'express';
import path from 'path';
import fs from 'fs';
import { attachStandardNotFoundAndErrorHandlers } from '../../NudeShared/server/index.js';
import { applySharedBase } from '../../NudeShared/server/app/applySharedBase.js';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Logger from '../../NudeShared/server/logger/serverLogger.js';
import { initDb } from '../../NudeShared/server/db/db.js';
import { runMigrations } from '../../NudeShared/server/db/migrate.js';
import { query, getDriver } from '../../NudeShared/server/db/db.js';
import { createStandardSessionMiddleware } from '../../NudeShared/server/middleware/sessionFactory.js';
import { buildAuthRouter } from '../../NudeShared/server/api/authRoutes.js';
import { buildProfileRouter } from '../../NudeShared/server/api/profileRoutes.js';
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
// Consolidated shared base setup (hardening, /shared, theme, auth, cache policy)
applySharedBase(app, {
  serviceName: 'NudeAdmin',
  projectDir: __dirname,
  sharedDir: path.resolve(__dirname, '..', '..', 'NudeShared'),
  // Defer auth mounting until after session + body parsers to avoid 401s during tests
  mountAuth: false,
  cachePolicies: {
    shared: { cssJs: 'public, max-age=3600', images: 'public, max-age=86400, stale-while-revalidate=604800' },
    thumbnails: 'public, max-age=86400',
    output: 'default (express static – adjust if needed)',
    themeCss: 'public, max-age=3600'
  },
  cachePolicyNote: 'Adjust caching logic in app.js if changing policies.'
});
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

// Resolve sharedDir early (needed by subsequent static mounts)
const sharedDir = process.env.NUDESHARED_DIR || path.resolve(PROJECT_ROOT, '..', 'NudeShared');

// Static: serve admin public and mount shared assets if available
app.use('/static', express.static(path.join(__dirname, 'public')));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Standard session middleware (memory or pg store depending on DATABASE_URL)
  app.set('trust proxy', 1);
  const adminSessionMw = await createStandardSessionMiddleware({ serviceName: 'NudeAdmin', domain: process.env.COOKIE_DOMAIN || undefined });
  app.use(adminSessionMw);

  // Auth routes mounted AFTER sessions/body parsing (shared base skipped auth via mountAuth:false)
  app.use('/auth', buildAuthRouter(express.Router));
  // Profile API (shared implementation) under /api
  app.use('/api', buildProfileRouter({ utils: { createSuccessResponse:(d,m='OK')=>({success:true,data:d,message:m}), createErrorResponse:(e)=>({success:false,error:e}), infoLog:()=>{}, errorLog:()=>{} }, siteTitle: 'NudeAdmin' }));
  // Serve default avatar asset if missing path referenced
  app.use('/images', express.static(path.join(sharedDir, 'client', 'images')));
  // Lightweight readiness for tests that only need profile
  app.get('/api/__ready', (req,res)=> res.json({ ok:true }));

// (Shared static + theme handled by applySharedBase)

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
    const normalized = path.normalize(rest)
      // sanitize: drop leading ./ or ../ chains then leading slashes only (keep internal dots)
      .replace(/^\.+[/]?/, '')
      .replace(/^[/]+/, '');
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

// Provide a lightweight factory for test environment to isolate thumbnail behavior without
// spinning up full admin auth/routes overhead. The test expects buildThumbnailTestApp to exist.
export function buildThumbnailTestApp(outputDir){
  const tApp = express();
  tApp.set('etag','strong');
  tApp.get('/thumbs/output/:rest(*)', async (req,res)=>{
    try {
      const rest = String(req.params.rest||'');
      // IMPORTANT: only strip LEADING dot segments / slashes to prevent path traversal while
      // preserving valid file extensions (the previous regex removed the first dot anywhere,
      // breaking filenames like sample.png -> samplepng and causing false 404s in tests).
      const normalized = path.normalize(rest)
        .replace(/^\.+[\\/]?/,'')  // drop leading ./ or ../ chains
        .replace(/^[\\/]+/,'');     // drop any leading slashes
      const abs = path.join(outputDir, normalized);
      if(!fs.existsSync(abs)) return res.status(404).send('Not found');
      const w = Number(req.query.w)||undefined; const h = Number(req.query.h)||undefined;
      const result = await getOrCreateOutputThumbnail(outputDir, normalized, { w, h, persist:true });
      res.set({ 'Cache-Control':'public, max-age=60', 'Content-Type':'image/jpeg' });
      return res.sendFile(result.filePath);
    } catch (e){
      Logger.error('ADMIN_THUMBS','Error (test factory) serving output thumbnail', { error: e?.message });
      return res.status(404).send('Thumbnail not available');
    }
  });
  return tApp;
}

// Lightweight factory used by consolidated smoke tests. Ensures DB init + migrations run
// before returning the configured Express instance. Idempotent because initDb + runMigrations
// are already safe for repeat calls.
export async function createApp(){
  try { await initDb(); await runMigrations(); } catch(e){ Logger.warn('ADMIN_APP','Init/migrate failed in createApp', { error: e?.message }); }
  return app;
}

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
} catch { /* ignore admin-created event binding */ }
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
    Logger.info('ADMIN_STATS','stats_start',{ period: req.query?.period, filter: req.query?.filter });
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
  // const likeExpr = (col) => driver === 'pg' ? `${col} ILIKE $X` : `LOWER(${col}) LIKE ?`; // reserved for future dynamic column filtering

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

    const payload = {
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
    };
    res.json(payload);
    Logger.info('ADMIN_STATS','stats_success', { totals: payload.totals, leaders: !!payload.leaders, metrics: !!payload.metrics });
  }catch(e){ Logger.error('ADMIN_STATS', e); res.status(500).json({ success:false, error:'Failed to load stats' }); }
});
app.get('/users', (req, res) => { res.render('users', { title: 'Users' }); });
app.get('/media', (req, res) => { res.render('media', { title: 'Media' }); });
// Legacy/alternate path support (some tests or old links may still request /admin/media)
app.get('/admin/media', (req, res) => { res.redirect(302, '/media'); });
app.get('/settings', (req, res) => { res.render('settings', { title: 'Settings' }); });
app.get('/profile', (req, res) => { res.render('profile', { title: 'Profile' }); });

// Legacy explicit /health retained for backward compatibility if monitors rely on JSON (hardening may have provided a redirect alias).
if (!app._router?.stack.some(r=> r.route?.path === '/health')) {
  app.get('/health', (req,res)=> res.redirect(302,'/healthz'));
}

// (Cache policy endpoint registered via applySharedBase)

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
  try {
      const { action, ids, title, /* category (deprecated legacy single category field) */ tags } = req.body||{};
    if(!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok:false, error:'No ids'});
    const placeholders = ids.map(()=>'?').join(',');
    const parseTags = (val)=> Array.from(new Set(String(val||'').split(/[ ,]+/).map(s=> s.trim().toLowerCase()).filter(Boolean).map(s=> s.slice(0,40))));
    let done = 0; let r;
    switch(action){
      case 'rename': {
        if(!title) return res.status(400).json({ok:false,error:'title required'});
        r = await query(`UPDATE media SET title=? WHERE id IN (${placeholders})`, [title, ...ids]);
        break;
      }
      case 'deactivate': {
        r = await query(`UPDATE media SET active=0 WHERE id IN (${placeholders})`, ids);
        break;
      }
      case 'activate': {
        r = await query(`UPDATE media SET active=1 WHERE id IN (${placeholders})`, ids);
        break;
      }
      case 'delete': {
        r = await query(`DELETE FROM media WHERE id IN (${placeholders})`, ids);
        break;
      }
      case 'add_tags': {
        const tagList = parseTags(tags);
        if(!tagList.length) return res.status(400).json({ ok:false, error:'tags required'});
        let inserted=0;
        for(const mid of ids){
          for(const tg of tagList){
            try { await query('INSERT OR IGNORE INTO media_tags (media_id, tag) VALUES (?,?)', [mid, tg]); inserted++; } catch {/*ignore*/}
          }
        }
        r = { changes: inserted };
        break;
      }
      case 'remove_tags': {
        const tagList = parseTags(tags);
        if(!tagList.length) return res.status(400).json({ ok:false, error:'tags required'});
        const tagMarks = tagList.map(()=>'?').join(',');
        r = await query(`DELETE FROM media_tags WHERE media_id IN (${placeholders}) AND tag IN (${tagMarks})`, [...ids, ...tagList]);
        break;
      }
      case 'replace_tags': {
        const tagList = parseTags(tags);
        await query(`DELETE FROM media_tags WHERE media_id IN (${placeholders})`, ids);
        let inserted=0;
        for(const mid of ids){
          for(const tg of tagList){
            try { await query('INSERT OR IGNORE INTO media_tags (media_id, tag) VALUES (?,?)', [mid, tg]); inserted++; }
            catch { /* ignore individual tag insert error (likely UNIQUE constraint) */ }
          }
        }
        r = { changes: inserted };
        break;
      }
      default: return res.status(400).json({ ok:false, error:'Unknown action'});
    }
    done = r?.rowCount ?? r?.changes ?? 0;
    res.json({ ok:true, action, affected: done });
  } catch(e){ Logger.error('ADMIN_MEDIA_ACTION', e); res.status(500).json({ ok:false, error:'Action failed'}); }
});


// Initialize DB/migrations BEFORE starting server to guarantee readiness for first request
const PORT = process.env.PORT || 8090;
async function start(){
  try {
    Logger.info('NUDEADMIN','DB_INIT_START');
    await initDb();
    Logger.info('NUDEADMIN','MIGRATIONS_START');
    await runMigrations();
    Logger.info('NUDEADMIN','DB_READY');
  } catch(e){
    Logger.error('NUDEADMIN','DB_INIT_FAILED', e);
  }
  if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    app.listen(PORT, () => { console.log(`[nudeadmin] listening on port ${PORT}`); });
  }
}
start();

export { app };

// Duplicate buildThumbnailTestApp removed (original defined earlier with persist:true)
attachStandardNotFoundAndErrorHandlers(app, { serviceName:'NudeAdmin' });
