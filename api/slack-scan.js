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
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return res.status(200).json({ tasks: [], message: 'No Slack token configured' });

    const since = Math.floor((Date.now() - 86400000) / 1000);
    const searchRes = await fetch(
      `https://slack.com/api/search.messages?query=to%3Ame&count=20&sort=timestamp&sort_dir=desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    if (!searchData.ok) return res.status(200).json({ tasks: [], message: 'Slack auth failed' });

    const messages = (searchData.messages?.matches || [])
      .filter(m => m.ts && parseFloat(m.ts) > since)
      .map(m => ({ text: m.text, from: m.username || m.user, channel: m.channel?.name || 'DM' }));

    if (messages.length === 0) return res.status(200).json({ tasks: [] });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: `Identify tasks for Natasha from these Slack messages. Return ONLY a JSON array: [{"task":string,"from":string,"channel":string,"priority":"high"|"med"|"low"}]. If nothing actionable return [].\n\n${messages.map(m => `From: ${m.from} | ${m.channel}\n${m.text}`).join('\n---\n')}` }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
    let tasks = [];
    try { tasks = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
    return res.status(200).json({ tasks });

  } catch (error) {
    console.error('Slack scan error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};