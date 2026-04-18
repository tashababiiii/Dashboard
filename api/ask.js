const Anthropic = require('@anthropic-ai/sdk');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { system, user, max_tokens = 1000 } = req.body || {};
    if (!system || !user) return res.status(400).json({ error: 'Missing params' });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens,
      system,
      messages: [{ role: 'user', content: user }]
    });
    return res.status(200).json({ text: msg.content?.find(b => b.type === 'text')?.text || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
