// Background sync — runs every 15 minutes via Vercel Cron
// Scans email and Slack for new tasks and surfaces them for the next dashboard load

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async (req, res) => {
  // Verify this is a legitimate cron request from Vercel
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { email: null, slack: null, timestamp: new Date().toISOString() };

  // ── EMAIL SCAN ──
  try {
    const tokenCookie = req.headers['x-gcal-token'];
    if (tokenCookie) {
      const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const listRes = await gmail.users.threads.list({
        userId: 'me',
        q: 'newer_than:1d -label:Unroll.me -from:unroll.me -from:noreply is:unread',
        maxResults: 10
      });

      const threads = listRes.data.threads || [];
      if (threads.length > 0) {
        const emailSummaries = await Promise.allSettled(
          threads.slice(0, 8).map(async t => {
            const thread = await gmail.users.threads.get({
              userId: 'me', id: t.id, format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date']
            });
            const msgs = thread.data.messages || [];
            const latest = msgs[msgs.length - 1];
            const headers = {};
            (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
            return { subject: headers['Subject'] || '(no subject)', from: headers['From'] || 'unknown', snippet: latest?.snippet || '' };
          })
        );

        const validEmails = emailSummaries.filter(r => r.status === 'fulfilled').map(r => r.value);

        if (validEmails.length > 0) {
          const msg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: `Triage these emails for Natasha Bradley, EA at 645 Ventures. Return ONLY valid JSON:
{"tasks":[{"subject":string,"from":string,"action":string,"priority":"high"|"med"|"low","workspace":"645"|"faye"|"personal"|"aaron"}],"waiting":[{"subject":string,"from":string,"waiting_for":string}]}

Emails:
${validEmails.map((e, i) => `${i+1}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n\n')}`
            }]
          });
          const raw = msg.content?.find(b => b.type === 'text')?.text || '{}';
          try { results.email = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
        }
      }
    }
  } catch(e) {
    results.emailError = e.message;
  }

  // ── SLACK SCAN ──
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    if (token) {
      const since = Math.floor((Date.now() - 900000) / 1000); // last 15 min
      const searchRes = await fetch(
        `https://slack.com/api/search.messages?query=to%3Ame&count=10&sort=timestamp&sort_dir=desc`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const searchData = await searchRes.json();
      const messages = (searchData.messages?.matches || [])
        .filter(m => m.ts && parseFloat(m.ts) > since)
        .map(m => ({ text: m.text, from: m.username || m.user, channel: m.channel?.name || 'DM' }));

      if (messages.length > 0) {
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Identify tasks for Natasha from these Slack messages. Return ONLY JSON array: [{"task":string,"from":string,"channel":string,"priority":"high"|"med"|"low"}]. If nothing actionable return [].\n\n${messages.map(m => `From: ${m.from} | ${m.channel}\n${m.text}`).join('\n---\n')}`
          }]
        });
        const raw = msg.content?.find(b => b.type === 'text')?.text || '[]';
        try { results.slack = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
      }
    }
  } catch(e) {
    results.slackError = e.message;
  }

  return res.status(200).json(results);
};