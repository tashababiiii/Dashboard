const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    list[name] = decodeURIComponent(rest.join('=').trim());
  });
  return list;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  try {
    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q: 'newer_than:1d -label:Unroll.me -from:unroll.me -from:noreply',
      maxResults: 20
    });

    const threads = listRes.data.threads || [];
    if (threads.length === 0) return res.status(200).json({ tasks: [], waiting: [], fyi: [] });

    const emailSummaries = await Promise.allSettled(
      threads.slice(0, 15).map(async t => {
        const thread = await gmail.users.threads.get({
          userId: 'me', id: t.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date']
        });
        const msgs = thread.data.messages || [];
        const latest = msgs[msgs.length - 1];
        const headers = {};
        (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
        return {
          subject: headers['Subject'] || '(no subject)',
          from: headers['From'] || 'unknown',
          snippet: latest?.snippet || ''
        };
      })
    );

    const validEmails = emailSummaries.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (validEmails.length === 0) return res.status(200).json({ tasks: [], waiting: [], fyi: [] });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Triage these emails for Natasha Bradley, EA & Office Manager at 645 Ventures NYC. Classify as TASK, WAITING, or FYI. Exclude marketing/newsletters/automated emails.

${validEmails.map((e, i) => `${i+1}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n\n')}

Return ONLY valid JSON:
{"tasks":[{"subject":string,"from":string,"action":string,"priority":"high"|"med"|"low","workspace":"645"|"faye"|"personal"|"aaron"}],"waiting":[{"subject":string,"from":string,"waiting_for":string,"since":string}],"fyi":[{"subject":string,"from":string,"summary":string}]}`
      }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '{}';
    let result = { tasks: [], waiting: [], fyi: [] };
    try { result = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
    return res.status(200).json(result);

  } catch (error) {
    console.error('Gmail scan error:', error.message);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }
    return res.status(500).json({ error: error.message });
  }
};