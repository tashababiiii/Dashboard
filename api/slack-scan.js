const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders } = require('./_utils');

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!parseCookies(req)['gcal_tokens']) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return res.status(200).json({ items: [], message: 'No Slack token configured' });

    const since = Math.floor((Date.now() - 86400000) / 1000);
    let searchRes;
    try {
      searchRes = await fetch(
        'https://slack.com/api/search.messages?query=to%3Ame&count=20&sort=timestamp&sort_dir=desc',
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch(e) {
      return res.status(200).json({ items: [], message: 'Slack unavailable' });
    }

    if (!searchRes.ok) return res.status(200).json({ items: [], message: 'Slack API error' });

    const searchData = await searchRes.json();
    if (!searchData.ok) return res.status(200).json({ items: [], message: 'Slack auth failed' });

    const messages = (searchData.messages?.matches || [])
      .filter(m => m.ts && parseFloat(m.ts) > since)
      .map(m => ({
        text: (m.text || '').slice(0, 300),
        from: (m.username || m.user || 'unknown').slice(0, 50),
        channel: (m.channel?.name || 'DM').slice(0, 50)
      }));

    if (messages.length === 0) return res.status(200).json({ items: [] });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Identify actionable tasks for Natasha from these Slack messages. Return ONLY a valid JSON array:
[{"title":"short action description","reason":"what needs to happen","from":"sender","channel":"channel name"}]
If nothing actionable, return [].

${messages.map(m => `From: ${m.from} | #${m.channel}\n${m.text}`).join('\n---\n')}`
      }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
    let items = [];
    try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
    return res.status(200).json({ items: Array.isArray(items) ? items : [] });

  } catch (error) {
    console.error('Slack scan error:', error.message);
    return res.status(500).json({ error: 'Scan failed', items: [] });
  }
};