const {
  readRecentMessages,
  readAnalyticsState,
  getOwnerSlug,
} = require('../../_lib/store');

const LIVE_DURATION_GRACE_SECONDS = 30;

function toTimestamp(value) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function computeEffectiveDuration(session) {
  const storedDuration = Math.max(0, Number(session?.duration_seconds) || 0);
  if (session?.ended_at) {
    return Math.max(1, storedDuration);
  }

  const startedAtMs = toTimestamp(session?.started_at);
  if (!startedAtMs) {
    return storedDuration;
  }

  const lastActivityMs =
    toTimestamp(session?.last_activity_at) ||
    toTimestamp(session?.started_at) ||
    startedAtMs;

  const nowMs = Date.now();
  const cappedNowMs = Math.min(nowMs, lastActivityMs + LIVE_DURATION_GRACE_SECONDS * 1000);
  const liveDuration = Math.max(1, Math.round((cappedNowMs - startedAtMs) / 1000));

  return Math.max(storedDuration, liveDuration);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ownerSlug = getOwnerSlug();
  const slug = req.query.slug;
  if (slug !== ownerSlug) {
    return res.status(404).json({ error: 'Not found' });
  }

  const [messages, analyticsState] = await Promise.all([
    readRecentMessages(200),
    readAnalyticsState(),
  ]);

  const sessions = Object.values(analyticsState.sessions || {});
  const visitorsMap = analyticsState.visitors || {};

  const enrichedSessions = sessions.map((session) => {
    const effectiveDuration = computeEffectiveDuration(session);

    return {
      ...session,
      duration_seconds: effectiveDuration,
    };
  });

  const totalVisits = enrichedSessions.length;
  const uniqueVisitors = Object.keys(visitorsMap).length;
  const returningVisits = enrichedSessions.filter((s) => s.visitor_type === 'returning').length;
  const avgTimeSpentSeconds = totalVisits
    ? Math.round(enrichedSessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0) / totalVisits)
    : 0;

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const todayVisits = enrichedSessions.filter((s) => (s.started_at || '').slice(0, 10) === todayKey).length;

  const countryCounter = {};
  for (const session of enrichedSessions) {
    const country = session.country || 'Unknown';
    countryCounter[country] = (countryCounter[country] || 0) + 1;
  }

  const topCountries = Object.entries(countryCounter)
    .map(([country, visits]) => ({ country, visits }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 8);

  const recentSessions = enrichedSessions
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
    .slice(0, 120)
    .map((s) => ({
      started_at: s.started_at,
      duration_seconds: s.duration_seconds,
      visitor_type: s.visitor_type,
      visitor_id_short: (s.visitor_id || '').slice(0, 10),
      page: s.page,
      country: s.country || 'Unknown',
    }));

  res.status(200).json({
    stats: {
      totalVisits,
      uniqueVisitors,
      returningVisits,
      avgTimeSpentSeconds,
      todayVisits,
    },
    messages,
    recentSessions,
    topCountries,
  });
};
