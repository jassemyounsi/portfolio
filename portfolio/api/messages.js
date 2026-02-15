const { appendMessage, readRecentMessages, parseBody, nowIso, newId } = require('./_lib/store');

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    const body = parseBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const row = {
      id: newId(),
      name,
      email,
      message,
      created_at: nowIso(),
    };
    try {
      await appendMessage(row);
      return res.status(200).json({ success: true, id: row.id });
    } catch (error) {
      return res.status(503).json({
        error: 'Storage unavailable',
        storagePaused: true,
      });
    }
  }

  if (req.method === 'GET') {
    const messages = await readRecentMessages(200);
    return res.status(200).json(messages || []);
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
