/**
 * /api/ask-image
 * Sends an image or document (base64) to Claude with a prompt and returns extracted text.
 * Used by the file upload feature in the morning modal and capture pill.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders } = require('./_utils');

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require auth cookie
  if (!parseCookies(req)['gcal_tokens']) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);

    const { image, mediaType, prompt } = body || {};

    if (!image) return res.status(400).json({ error: 'Missing image data' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Cap image size — base64 of 10MB file = ~13MB string
    if (image.length > 15_000_000) {
      return res.status(400).json({ error: 'File too large — please use a file under 10MB' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Use claude-3-5-sonnet for vision — haiku doesn't support image input reliably
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType || 'image/jpeg',
              data: image
            }
          },
          {
            type: 'text',
            text: String(prompt).slice(0, 2000)
          }
        ]
      }]
    });

    const text = message.content?.find(b => b.type === 'text')?.text || '';
    return res.status(200).json({ text });

  } catch (error) {
    console.error('ask-image error:', error.message);
    // Specific error for unsupported media type
    if (error.message?.includes('media_type') || error.message?.includes('invalid')) {
      return res.status(400).json({ error: 'Unsupported file type — try a PNG, JPG, or PDF' });
    }
    return res.status(500).json({ error: 'Could not read file — try again' });
  }
};