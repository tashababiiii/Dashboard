const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Handle body parsing - Vercel may pass body as string or object
    let body = req.body;
    if (!body) {
      // Manual body parsing if needed
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }

    const system = body?.system;
    const user = body?.user;
    const max_tokens = body?.max_tokens || 1000;

    if (!system || !user) {
      return res.status(400).json({ 
        error: 'Missing system or user prompt', 
        received_keys: Object.keys(body || {}),
        body_type: typeof body
      });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens,
      system,
      messages: [{ role: 'user', content: user }]
    });

    const text = message.content?.find(b => b.type === 'text')?.text || '';
    return res.status(200).json({ text });

  } catch (error) {
    console.error('Ask API error:', error.message, error.stack);
    return res.status(500).json({ error: error.message, stack: error.stack?.split('\n')[0] });
  }
};