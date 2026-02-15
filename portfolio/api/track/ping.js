const { readAnalyticsState, writeAnalyticsState, parseBody, nowIso } = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = parseBody(req);
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
  const duration = Math.max(1, Math.min(86400, Number(body.durationSeconds) || 0));

  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const state = await readAnalyticsState();
  const session = state.sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  if (session.ended_at) {
    return res.status(200).json({ success: true });
  }

  session.duration_seconds = Math.max(session.duration_seconds || 0, duration);
  session.last_activity_at = nowIso();
  await writeAnalyticsState(state);

  return res.status(200).json({ success: true });
};
