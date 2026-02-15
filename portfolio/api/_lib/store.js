const { list, put } = require('@vercel/blob');
const crypto = require('crypto');

const MESSAGES_PATH = 'portfolio-messages.json';
const ANALYTICS_PATH = 'portfolio-analytics.json';
const LEGACY_STATE_PATH = 'portfolio-state.json';
const MESSAGE_ITEM_PREFIX = 'portfolio-messages/';
const MAX_MESSAGES = 5000;

function defaultMessagesState() {
  return {
    messages: [],
  };
}

function defaultAnalyticsState() {
  return {
    visitors: {},
    sessions: {},
  };
}

async function readBlobJson(pathname) {
  const blobs = await list({ prefix: pathname, limit: 20 });
  if (!blobs?.blobs?.length) {
    return null;
  }

  const target = blobs.blobs
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.uploadedAt || 0).getTime();
      const tb = new Date(b.uploadedAt || 0).getTime();
      return tb - ta;
    })[0];

  const response = await fetch(`${target.url}?t=${Date.now()}`);
  if (!response.ok) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function writeBlobJson(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

async function readMessagesState() {
  const data = await readBlobJson(MESSAGES_PATH);
  if (!data || typeof data !== 'object') {
    const legacy = await readBlobJson(LEGACY_STATE_PATH);
    if (!legacy || typeof legacy !== 'object') return defaultMessagesState();
    return {
      messages: Array.isArray(legacy.messages) ? legacy.messages : [],
    };
  }
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
  };
}

async function writeMessagesState(state) {
  const safeState = {
    messages: Array.isArray(state?.messages) ? state.messages : [],
  };
  await writeBlobJson(MESSAGES_PATH, safeState);
}

function sanitizeMessageRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' ? row.id : null;
  const name = typeof row.name === 'string' ? row.name : '';
  const email = typeof row.email === 'string' ? row.email : '';
  const message = typeof row.message === 'string' ? row.message : '';
  const created_at = typeof row.created_at === 'string' ? row.created_at : nowIso();
  if (!id || !name || !email || !message) return null;
  return { id, name, email, message, created_at };
}

async function appendMessage(row) {
  const safe = sanitizeMessageRow(row);
  if (!safe) {
    throw new Error('Invalid message row');
  }

  if (hasGistMessageStorage()) {
    const messages = await readMessagesFromGist();
    messages.unshift(safe);
    await writeMessagesToGist(messages.slice(0, MAX_MESSAGES));
    return;
  }

  const state = await readMessagesState();
  state.messages.unshift(safe);
  state.messages = state.messages.slice(0, MAX_MESSAGES);
  await writeMessagesState(state);
}

async function readRecentMessages(limit = 200) {
  if (hasGistMessageStorage()) {
    const messages = await readMessagesFromGist();
    return messages
      .map((row) => sanitizeMessageRow(row))
      .filter(Boolean)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  const state = await readMessagesState();
  const compactMessages = (state.messages || [])
    .map((row) => sanitizeMessageRow(row))
    .filter(Boolean)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  if (compactMessages.length >= limit) {
    return compactMessages.slice(0, limit);
  }

  try {
    const itemListing = await list({ prefix: MESSAGE_ITEM_PREFIX, limit: Math.max(limit, 200) });
    const itemBlobs = itemListing?.blobs || [];
    if (!itemBlobs.length) {
      return compactMessages.slice(0, limit);
    }

    const legacyCandidates = itemBlobs
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.uploadedAt || 0).getTime();
        const tb = new Date(b.uploadedAt || 0).getTime();
        return tb - ta;
      })
      .slice(0, limit);

    const legacyRows = await Promise.all(
      legacyCandidates.map(async (blob) => {
        try {
          const response = await fetch(`${blob.url}?t=${Date.now()}`);
          if (!response.ok) return null;
          const data = await response.json();
          return sanitizeMessageRow(data);
        } catch {
          return null;
        }
      })
    );

    const deduped = new Map();
    for (const row of compactMessages) {
      if (row?.id) deduped.set(row.id, row);
    }
    for (const row of legacyRows) {
      if (row?.id && !deduped.has(row.id)) {
        deduped.set(row.id, row);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  } catch {
    return compactMessages.slice(0, limit);
  }
}

function hasGistMessageStorage() {
  return Boolean(process.env.GITHUB_GIST_ID && process.env.GITHUB_TOKEN);
}

async function readGistFile(gistId, token, fileName) {
  const response = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jassem-portfolio',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub Gist read failed: ${response.status}`);
  }

  const gist = await response.json();
  const fileMeta = gist?.files?.[fileName];
  if (!fileMeta) return null;

  if (typeof fileMeta.content === 'string') return fileMeta.content;
  if (fileMeta.raw_url) {
    const raw = await fetch(fileMeta.raw_url, { headers: { 'User-Agent': 'jassem-portfolio' } });
    if (!raw.ok) return null;
    return await raw.text();
  }
  return null;
}

async function readMessagesFromGist() {
  const gistId = process.env.GITHUB_GIST_ID;
  const token = process.env.GITHUB_TOKEN;
  const fileName = process.env.GITHUB_GIST_MESSAGES_FILE || 'messages.json';
  if (!gistId || !token) return [];

  try {
    const content = await readGistFile(gistId, token, fileName);
    if (!content) return [];
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return [];
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

async function writeMessagesToGist(messages) {
  const gistId = process.env.GITHUB_GIST_ID;
  const token = process.env.GITHUB_TOKEN;
  const fileName = process.env.GITHUB_GIST_MESSAGES_FILE || 'messages.json';
  if (!gistId || !token) {
    throw new Error('Gist storage is not configured');
  }

  const payload = {
    messages: Array.isArray(messages) ? messages : [],
    updatedAt: nowIso(),
  };

  const response = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'jassem-portfolio',
    },
    body: JSON.stringify({
      files: {
        [fileName]: {
          content: JSON.stringify(payload, null, 2),
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub Gist write failed: ${response.status}`);
  }
}

async function readAnalyticsState() {
  const data = await readBlobJson(ANALYTICS_PATH);
  if (!data || typeof data !== 'object') {
    const legacy = await readBlobJson(LEGACY_STATE_PATH);
    if (!legacy || typeof legacy !== 'object') return defaultAnalyticsState();
    return {
      visitors: legacy.visitors && typeof legacy.visitors === 'object' ? legacy.visitors : {},
      sessions: legacy.sessions && typeof legacy.sessions === 'object' ? legacy.sessions : {},
    };
  }
  return {
    visitors: data.visitors && typeof data.visitors === 'object' ? data.visitors : {},
    sessions: data.sessions && typeof data.sessions === 'object' ? data.sessions : {},
  };
}

async function writeAnalyticsState(state) {
  const safeState = {
    visitors: state?.visitors && typeof state.visitors === 'object' ? state.visitors : {},
    sessions: state?.sessions && typeof state.sessions === 'object' ? state.sessions : {},
  };
  await writeBlobJson(ANALYTICS_PATH, safeState);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

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

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return normalizeIp(forwarded.split(',')[0].trim());
  }
  return normalizeIp(req.socket?.remoteAddress || 'unknown');
}

function getCountryFromHeaders(req) {
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
  return null;
}

async function getVisitorCountry(req) {
  const fromHeaders = getCountryFromHeaders(req);
  if (fromHeaders) return fromHeaders;

  const ip = getClientIp(req);
  if (isPrivateOrLocalIp(ip)) return 'Unknown';

  try {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) return 'Unknown';
    const country = (await response.text()).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) return country;
    return 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function getOwnerSlug() {
  return (process.env.OWNER_DASH_SLUG || 'jassem-owner-9f4k2m').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function durationSince(startedAt) {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  if (!Number.isFinite(start)) return 0;
  return Math.max(1, Math.round((now - start) / 1000));
}

module.exports = {
  readMessagesState,
  writeMessagesState,
  appendMessage,
  readRecentMessages,
  readAnalyticsState,
  writeAnalyticsState,
  parseBody,
  parseCookies,
  getClientIp,
  getVisitorCountry,
  getOwnerSlug,
  nowIso,
  newId,
  durationSince,
};
