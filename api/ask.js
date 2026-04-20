/**
 * /api/ask
 * Unified Claude endpoint — handles both text and image/file inputs.
 * If body contains `image` (base64) → vision mode using Sonnet
 * If body contains `system` + `user` → text mode using Haiku
 */

const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders, parseBody } = require('./_utils');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!parseCookies(req)['gcal_tokens']) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    let body;
    try {
      body = await parseBody(req);
    } catch(e) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);

    // ── IMAGE / VISION MODE ──────────────────────────────────────
    if (body.image) {
      const { image, mediaType, prompt } = body;
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
      if (image.length > 15_000_000) return res.status(400).json({ error: 'File too large — try under 10MB' });

      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: String(prompt).slice(0, 2000) }
          ]
        }]
      });

      return res.status(200).json({ text: msg.content?.find(b => b.type === 'text')?.text || '' });
    }

    // ── TEXT MODE ────────────────────────────────────────────────
    const { system, user } = body;
    if (!system || !user) return res.status(400).json({ error: 'Missing params' });

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: String(system).slice(0, 4000),
      messages: [{ role: 'user', content: String(user).slice(0, 8000) }]
    });

    return res.status(200).json({ text: msg.content?.find(b => b.type === 'text')?.text || '' });

  } catch (e) {
    console.error('Ask error:', e.message);
    if (e.message?.includes('media_type') || e.message?.includes('invalid')) {
      return res.status(400).json({ error: 'Unsupported file type — try PNG, JPG, or PDF' });
    }
    return res.status(500).json({ error: 'Request failed' });
  }
};