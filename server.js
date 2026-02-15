const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const geoip = require('geoip-lite');

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_DASH_SLUG = process.env.OWNER_DASH_SLUG || 'jassem-owner-9f4k2m';
const LIVE_DURATION_GRACE_SECONDS = 30;

// --- SQLite setup ---
const db = new Database(path.join(__dirname, 'messages.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    email      TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS visitors (
    id         TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    visits     INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT,
    ip         TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    visitor_id       TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    page             TEXT,
    user_agent       TEXT,
    ip               TEXT,
    visitor_type     TEXT NOT NULL,
    FOREIGN KEY(visitor_id) REFERENCES visitors(id)
  )
`);

function ensureColumn(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((col) => col.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

ensureColumn('visitors', 'country', "TEXT DEFAULT 'Unknown'");
ensureColumn('sessions', 'country', "TEXT DEFAULT 'Unknown'");
ensureColumn('sessions', 'last_activity_at', 'TEXT');

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'portfolio')));

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = decodeURIComponent(part.slice(0, idx));
      const value = decodeURIComponent(part.slice(idx + 1));
      acc[key] = value;
      return acc;
    }, {});
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown';
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.replace('::ffff:', '');
  return trimmed;
}

function isPrivateOrLocalIp(ip) {
  if (!ip || ip === 'unknown') return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  return false;
}

function getVisitorCountry(req) {
  const raw =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['cloudfront-viewer-country'] ||
    req.headers['x-country-code'] ||
    req.headers['x-appengine-country'];

  if (typeof raw === 'string') {
    const country = raw.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) return country;
  }

  const ip = normalizeIp(getClientIp(req));
  if (isPrivateOrLocalIp(ip)) return 'Unknown';

  const geo = geoip.lookup(ip);
  if (geo?.country && /^[A-Z]{2}$/.test(geo.country)) {
    return geo.country;
  }

  return 'Unknown';
}

function requireOwnerAccess(req, res, next) {
  if (req.params.slug !== OWNER_DASH_SLUG) {
    return res.status(404).send('Not found');
  }
  next();
}

app.post('/api/track/start', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  let visitorId = cookies.jy_vid;
  const now = new Date().toISOString();
  const userAgent = req.headers['user-agent'] || 'unknown';
  const ip = normalizeIp(getClientIp(req));
  const country = getVisitorCountry(req);
  const page = typeof req.body?.page === 'string' ? req.body.page.slice(0, 500) : '/';

  if (!visitorId) {
    visitorId = crypto.randomUUID();
    res.setHeader(
      'Set-Cookie',
      `jy_vid=${encodeURIComponent(visitorId)}; Path=/; Max-Age=63072000; SameSite=Lax`
    );
  }

  const existingVisitor = db.prepare('SELECT id FROM visitors WHERE id = ?').get(visitorId);
  const visitorType = existingVisitor ? 'returning' : 'new';

  if (existingVisitor) {
    db.prepare(
      `UPDATE visitors
       SET last_seen = ?, visits = visits + 1, user_agent = ?, ip = ?, country = ?
       WHERE id = ?`
    ).run(now, userAgent, ip, country, visitorId);
  } else {
    db.prepare(
      `INSERT INTO visitors (id, first_seen, last_seen, visits, user_agent, ip, country)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    ).run(visitorId, now, now, userAgent, ip, country);
  }

  const sessionId = crypto.randomUUID();
  db.prepare(
     `INSERT INTO sessions (id, visitor_id, started_at, page, user_agent, ip, visitor_type, country)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, visitorId, now, page, userAgent, ip, visitorType, country);

  db.prepare(
     `UPDATE sessions
      SET last_activity_at = ?
      WHERE id = ?`
    ).run(now, sessionId);

  res.json({ success: true, sessionId, visitorType });
});

app.post('/api/track/ping', (req, res) => {
  const { sessionId, durationSeconds } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const duration = Math.max(1, Math.min(86400, Number(durationSeconds) || 0));
  db.prepare(
    `UPDATE sessions
     SET duration_seconds = CASE WHEN ? > duration_seconds THEN ? ELSE duration_seconds END,
         last_activity_at = ?
     WHERE id = ?`
  ).run(duration, duration, new Date().toISOString(), sessionId);

  res.json({ success: true });
});

app.post('/api/track/end', (req, res) => {
  const { sessionId, durationSeconds } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const duration = Math.max(0, Math.min(86400, Number(durationSeconds) || 0));
  const endedAt = new Date().toISOString();

  db.prepare(
    `UPDATE sessions
      SET ended_at = COALESCE(ended_at, ?),
          duration_seconds = CASE WHEN ? > duration_seconds THEN ? ELSE duration_seconds END,
          last_activity_at = ?
     WHERE id = ?`
    ).run(endedAt, duration, duration, endedAt, sessionId);

  res.json({ success: true });
});

// --- API: save a message ---
app.post('/api/messages', (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const stmt = db.prepare('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)');
    const info = stmt.run(name, email, message);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save message.' });
  }
});

// --- Private dashboard (owner only) ---
app.get('/owner/:slug', requireOwnerAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'portfolio', 'owner-dashboard.html'));
});

app.get('/api/private/:slug/dashboard-data', requireOwnerAccess, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_visits,
      COUNT(DISTINCT visitor_id) AS unique_visitors,
      SUM(CASE WHEN visitor_type = 'returning' THEN 1 ELSE 0 END) AS returning_visits,
      AVG(
        CASE
          WHEN ended_at IS NOT NULL AND duration_seconds > 0 THEN duration_seconds
          WHEN ended_at IS NOT NULL THEN MAX(1, CAST((julianday(ended_at) - julianday(started_at)) * 86400 AS INTEGER))
          ELSE MAX(
            duration_seconds,
            MAX(
              1,
              CAST((
                julianday(
                  CASE
                    WHEN datetime('now') < datetime(COALESCE(last_activity_at, started_at), '+${LIVE_DURATION_GRACE_SECONDS} seconds')
                      THEN datetime('now')
                    ELSE datetime(COALESCE(last_activity_at, started_at), '+${LIVE_DURATION_GRACE_SECONDS} seconds')
                  END
                ) - julianday(started_at)
              ) * 86400 AS INTEGER)
            )
          )
        END
      ) AS avg_time_spent_seconds
    FROM sessions
  `).get();

  const today = db.prepare(`
    SELECT COUNT(*) AS today_visits
    FROM sessions
    WHERE date(started_at) = date('now')
  `).get();

  const messages = db.prepare(
    'SELECT id, name, email, message, created_at FROM messages ORDER BY created_at DESC LIMIT 200'
  ).all();

  const recentSessions = db.prepare(`
    SELECT
      started_at,
      CASE
        WHEN ended_at IS NOT NULL AND duration_seconds > 0 THEN duration_seconds
        WHEN ended_at IS NOT NULL THEN MAX(1, CAST((julianday(ended_at) - julianday(started_at)) * 86400 AS INTEGER))
        ELSE MAX(
          duration_seconds,
          MAX(
            1,
            CAST((
              julianday(
                CASE
                  WHEN datetime('now') < datetime(COALESCE(last_activity_at, started_at), '+${LIVE_DURATION_GRACE_SECONDS} seconds')
                    THEN datetime('now')
                  ELSE datetime(COALESCE(last_activity_at, started_at), '+${LIVE_DURATION_GRACE_SECONDS} seconds')
                END
              ) - julianday(started_at)
            ) * 86400 AS INTEGER)
          )
        )
      END AS duration_seconds,
      visitor_type,
      substr(visitor_id, 1, 10) AS visitor_id_short,
      page,
      country
    FROM sessions
    ORDER BY started_at DESC
    LIMIT 120
  `).all();

  const topCountries = db.prepare(`
    SELECT country, COUNT(*) AS visits
    FROM sessions
    GROUP BY country
    ORDER BY visits DESC
    LIMIT 8
  `).all();

  res.json({
    stats: {
      totalVisits: stats.total_visits || 0,
      uniqueVisitors: stats.unique_visitors || 0,
      returningVisits: stats.returning_visits || 0,
      avgTimeSpentSeconds: Math.round(stats.avg_time_spent_seconds || 0),
      todayVisits: today.today_visits || 0,
    },
    messages,
    recentSessions,
    topCountries,
  });
});

// --- Serve portfolio for any other route ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'portfolio', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
