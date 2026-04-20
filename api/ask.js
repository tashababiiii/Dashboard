const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders, parseBody } = require('./_utils');

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require auth cookie — prevents unauthenticated API credit drain
  if (!parseCookies(req)['gcal_tokens']) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { system, user } = await parseBody(req);
    if (!system || !user) return res.status(400).json({ error: 'Missing params' });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: String(system).slice(0, 4000),
      messages: [{ role: 'user', content: String(user).slice(0, 8000) }]
    });

    return res.status(200).json({ text: msg.content?.find(b => b.type === 'text')?.text || '' });
  } catch (e) {
    console.error('Ask error:', e.message);
    return res.status(500).json({ error: 'Request failed' });
  }
};