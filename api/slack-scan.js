const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders } = require('./_utils');

// All key channels to scan
const KEY_CHANNELS = [
  { id: 'C1P17H3GC',  name: 'general' },
  { id: 'C08EW48HFPX', name: '645-nyc' },
  { id: 'CAFJYFWJ3',  name: '645ops' },
  { id: 'CAK4UDVC0',  name: 'events' },
  { id: 'C01CS2AJDT5', name: 'investment-and-research' },
];

// All DMs to scan (Natasha's key contacts)
const DM_USERS = [
  { id: 'U1P4Z0MEE', name: 'Aaron Holiday' },
  { id: 'U1P2SM2DP', name: 'Nnamdi Okike' },
  { id: 'U039T998093', name: 'Randi Jakubowitz' },
  { id: 'U042N9VG5KP', name: 'Meredith Tibbals' },
  { id: 'U01NWS5GQSX', name: 'Lexi Quirk' },
  { id: 'U05RBK6L5SM', name: 'William Hess' },
  { id: 'U046F0S9J30', name: 'Britt Binler' },
  { id: 'U064UD1PE1M', name: 'Pete Keenan' },
  { id: 'U08B07TADJA', name: 'Christina Siadat' },
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

    // Fetch all DMs + all channels in parallel
    const dmFetches = DM_USERS.map(u =>
      fetch(`https://slack.com/api/conversations.history?channel=${u.id}&oldest=${since}&limit=15`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.ok ? r.json() : null).then(data => ({ data, meta: u, type: 'dm' })).catch(() => null)
    );

    const channelFetches = KEY_CHANNELS.map(c =>
      fetch(`https://slack.com/api/conversations.history?channel=${c.id}&oldest=${since}&limit=20`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.ok ? r.json() : null).then(data => ({ data, meta: c, type: 'channel' })).catch(() => null)
    );

    // Also fetch Natasha's user ID mentions across all channels
    const mentionFetch = fetch(
      `https://slack.com/api/search.messages?query=<@U09QDB978KY>&count=20&sort=timestamp&sort_dir=desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.ok ? r.json() : null).catch(() => null);

    const allResults = await Promise.all([...dmFetches, ...channelFetches, mentionFetch]);

    const messages = [];
    const seenTexts = new Set();

    const addMsg = (text, from, channel) => {
      const t = text.slice(0, 400);
      if (!seenTexts.has(t) && t.length > 5) {
        seenTexts.add(t);
        messages.push({ text: t, from, channel });
      }
    };

    // Process DM results
    for (const result of allResults.slice(0, DM_USERS.length)) {
      if (!result?.data?.ok || !result.data.messages) continue;
      for (const m of result.data.messages) {
        if (m.type === 'message' && m.text && !m.bot_id && m.user !== 'U09QDB978KY') {
          addMsg(m.text, result.meta.name, `DM from ${result.meta.name}`);
        }
      }
    }

    // Process channel results
    for (const result of allResults.slice(DM_USERS.length, DM_USERS.length + KEY_CHANNELS.length)) {
      if (!result?.data?.ok || !result.data.messages) continue;
      for (const m of result.data.messages) {
        if (m.type === 'message' && m.text && !m.bot_id && m.user !== 'U09QDB978KY') {
          // Only include if it mentions Natasha or seems like a request/task
          const lower = m.text.toLowerCase();
          const relevant = m.text.includes('<@U09QDB978KY>') ||
            lower.includes('natasha') ||
            lower.includes('nbradley') ||
            lower.includes('can you') || lower.includes('could you') ||
            lower.includes('please') || lower.includes('need you') ||
            lower.includes('can we') || lower.includes('?');
          if (relevant) {
            addMsg(m.text, m.user || 'unknown', `#${result.meta.name}`);
          }
        }
      }
    }

    // Process @mention search results
    const mentionData = allResults[allResults.length - 1];
    if (mentionData?.ok && mentionData.messages?.matches) {
      for (const m of mentionData.messages.matches) {
        if (m.ts && parseFloat(m.ts) > parseFloat(since)) {
          addMsg(m.text || '', m.username || 'unknown', m.channel?.name || 'unknown');
        }
      }
    }

    if (messages.length === 0) return res.status(200).json({ items: [] });

    // Resolve user IDs to names in message texts
    const userMap = {};
    DM_USERS.forEach(u => { userMap[u.id] = u.name; });
    userMap['U09QDB978KY'] = 'Natasha';

    const resolvedMessages = messages.map(m => ({
      ...m,
      text: m.text.replace(/<@([A-Z0-9]+)>/g, (_, id) => userMap[id] ? `@${userMap[id]}` : `@${id}`)
    }));

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const aiMessage = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Identify actionable tasks for Natasha Bradley (EA/Office Manager at 645 Ventures, user ID U09QDB978KY) from these Slack messages from the last 24 hours.

Include: direct requests, questions needing a reply, tasks assigned to her, follow-ups she needs to do, anything mentioning her name or @Natasha.
Exclude: general announcements, messages she sent, FYI-only messages with no action needed.

Return ONLY a valid JSON array:
[{"title":"short action description under 8 words","reason":"what needs to happen and who asked","from":"sender name","channel":"channel or DM source","priority":"high|med|low"}]

Priority: high if from Aaron or urgent language; med for most requests; low for casual asks.
If nothing actionable for Natasha, return [].

Messages (last 24hrs):
${resolvedMessages.map(m => `From: ${m.from} | ${m.channel}\n${m.text}`).join('\n---\n')}`
      }]
    });

    const raw = aiMessage.content?.find(b => b.type === 'text')?.text || '[]';
    let items = [];
    try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
    return res.status(200).json({ items: Array.isArray(items) ? items : [] });

  } catch (error) {
    console.error('Slack scan error:', error.message);
    return res.status(500).json({ error: 'Scan failed', items: [] });
  }
};
