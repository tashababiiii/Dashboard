// Background sync — runs daily at 8am via Vercel Cron
// Scans Slack for new actionable messages
// Note: Email scan requires a user session cookie and cannot run server-side in cron.
// Use the Smart Sync button on the dashboard for email scanning.

const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { slack: null, timestamp: new Date().toISOString() };

  try {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return res.status(200).json({ ...results, message: 'No Slack token' });

    const since = Math.floor((Date.now() - 900000) / 1000);
    let searchRes;
    try {
      searchRes = await fetch(
        'https://slack.com/api/search.messages?query=to%3Ame&count=10&sort=timestamp&sort_dir=desc',
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch(e) {
      return res.status(200).json({ ...results, slackError: 'Slack unreachable' });
    }

    if (!searchRes.ok) return res.status(200).json({ ...results, slackError: 'Slack HTTP error' });

    const searchData = await searchRes.json();
    if (!searchData.ok) return res.status(200).json({ ...results, slackError: searchData.error });

    const messages = (searchData.messages?.matches || [])
      .filter(m => m.ts && parseFloat(m.ts) > since)
      .map(m => ({
        text: (m.text || '').slice(0, 300),
        from: (m.username || m.user || 'unknown').slice(0, 50),
        channel: (m.channel?.name || 'DM').slice(0, 50)
      }));

    if (messages.length === 0) return res.status(200).json({ ...results, slack: [] });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Identify tasks for Natasha from these Slack messages. Return ONLY a JSON array:
[{"task":string,"from":string,"channel":string,"priority":"high"|"med"|"low"}]
If nothing actionable return [].

${messages.map(m => `From: ${m.from} | ${m.channel}\n${m.text}`).join('\n---\n')}`
      }]
    });

    const raw = msg.content?.find(b => b.type === 'text')?.text || '[]';
    try { results.slack = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) { results.slack = []; }

  } catch(e) {
    results.slackError = e.message;
  }

  return res.status(200).json(results);
};