const {
  readAnalyticsState,
  writeAnalyticsState,
  parseBody,
  parseCookies,
  getClientIp,
  getVisitorCountry,
  nowIso,
  newId,
} = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = parseBody(req);
  const cookies = parseCookies(req.headers.cookie || '');
  let visitorId = cookies.jy_vid;
  const now = nowIso();
  const userAgent = req.headers['user-agent'] || 'unknown';
  const ip = getClientIp(req);
  const country = await getVisitorCountry(req);
  const page = typeof body.page === 'string' ? body.page.slice(0, 500) : '/';

  if (!visitorId) {
    visitorId = newId();
    res.setHeader(
      'Set-Cookie',
      `jy_vid=${encodeURIComponent(visitorId)}; Path=/; Max-Age=63072000; SameSite=Lax; Secure`
    );
  }

  const state = await readAnalyticsState();
  const existingVisitor = state.visitors[visitorId];
  const visitorType = existingVisitor ? 'returning' : 'new';

  state.visitors[visitorId] = {
    id: visitorId,
    first_seen: existingVisitor?.first_seen || now,
    last_seen: now,
    visits: (existingVisitor?.visits || 0) + 1,
    user_agent: userAgent,
    ip,
    country,
  };

  const sessionId = newId();
  state.sessions[sessionId] = {
    id: sessionId,
    visitor_id: visitorId,
    started_at: now,
    last_activity_at: now,
    ended_at: null,
    duration_seconds: 0,
    page,
    user_agent: userAgent,
    ip,
    visitor_type: visitorType,
    country,
  };

  await writeAnalyticsState(state);
  return res.status(200).json({ success: true, sessionId, visitorType });
};
