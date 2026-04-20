const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders } = require('./_utils');

// Aaron's DM channel ID and key people to check
const AARON_DM = 'U1P4Z0MEE'; // Aaron Holiday user ID — used as DM channel
const KEY_CHANNELS = [
  { id: 'CAFJYFWJ3', name: '645ops' },
  { id: 'C08EW48HFPX', name: '645-nyc' },
];

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

    // Look back 24 hours
    const since = String(Math.floor((Date.now() - 86400000) / 1000));

    // Fetch DMs from Aaron + key channels in parallel
    const fetches = [
      // Aaron DM channel
      fetch(`https://slack.com/api/conversations.history?channel=${AARON_DM}&oldest=${since}&limit=20`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      // Also try search for any messages directed at Natasha
      fetch(`https://slack.com/api/search.messages?query=to%3Ame&count=15&sort=timestamp&sort_dir=desc`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      // 645ops channel
      fetch(`https://slack.com/api/conversations.history?channel=${KEY_CHANNELS[0].id}&oldest=${since}&limit=10`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ];

    const results = await Promise.allSettled(fetches.map(f => f.then(r => r.ok ? r.json() : null)));

    const messages = [];
    const seenTexts = new Set();

    // Aaron DM messages
    const aaronData = results[0].status === 'fulfilled' ? results[0].value : null;
    if (aaronData?.ok && aaronData.messages) {
      for (const m of aaronData.messages) {
        if (m.type === 'message' && m.text && !m.bot_id) {
          const text = m.text.slice(0, 300);
          if (!seenTexts.has(text)) {
            seenTexts.add(text);
            messages.push({ text, from: 'Aaron Holiday', channel: 'DM' });
          }
        }
      }
    }

    // Search results
    const searchData = results[1].status === 'fulfilled' ? results[1].value : null;
    if (searchData?.ok && searchData.messages?.matches) {
      for (const m of searchData.messages.matches) {
        if (m.ts && parseFloat(m.ts) > parseFloat(since)) {
          const text = (m.text || '').slice(0, 300);
          if (!seenTexts.has(text)) {
            seenTexts.add(text);
            messages.push({
              text,
              from: m.username || m.user || 'unknown',
              channel: m.channel?.name || 'DM'
            });
          }
        }
      }
    }

    // 645ops messages
    const opsData = results[2].status === 'fulfilled' ? results[2].value : null;
    if (opsData?.ok && opsData.messages) {
      for (const m of opsData.messages) {
        if (m.type === 'message' && m.text && !m.bot_id) {
          const text = m.text.slice(0, 300);
          if (!seenTexts.has(text)) {
            seenTexts.add(text);
            messages.push({ text, from: m.user || 'unknown', channel: '645ops' });
          }
        }
      }
    }

    if (messages.length === 0) return res.status(200).json({ items: [] });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Identify actionable tasks for Natasha Bradley (EA at 645 Ventures) from these Slack messages. Flag anything that needs her attention — requests from Aaron, questions needing a reply, tasks, or follow-ups.

Return ONLY a valid JSON array:
[{"title":"short action description","reason":"what needs to happen","from":"sender","channel":"channel name"}]

If nothing actionable, return [].

Messages (last 24hrs):
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