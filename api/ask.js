const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Parse body manually if needed
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) {}
    }
    if (!body) {
      return res.status(400).json({ error: 'Empty request body' });
    }

    const { system, user, max_tokens = 1000 } = body;
    if (!system || !user) {
      return res.status(400).json({ error: 'Missing system or user prompt', received: Object.keys(body) });
    }

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens,
      system,
      messages: [{ role: 'user', content: user }]
    });

    const text = message.content?.find(b => b.type === 'text')?.text || '';
    return res.status(200).json({ text });
  } catch (error) {
    console.error('Ask API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};