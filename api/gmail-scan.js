const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
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

  if (!tokenCookie) {
    return res.status(401).json({ error: 'Not authenticated with Google', needsAuth: true });
  }

  try {
    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q: 'newer_than:1d -label:Unroll.me -from:unroll.me -from:noreply',
      maxResults: 25
    });

    const threads = listRes.data.threads || [];
    if (threads.length === 0) {
      return res.status(200).json({ tasks: [], waiting: [], fyi: [] });
    }

    const emailSummaries = await Promise.allSettled(
      threads.slice(0, 20).map(async t => {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: t.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date']
        });
        const msgs = thread.data.messages || [];
        const latest = msgs[msgs.length - 1];
        const headers = {};
        (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
        return {
          subject: headers['Subject'] || '(no subject)',
          from: headers['From'] || 'unknown',
          date: headers['Date'] || '',
          snippet: latest?.snippet || ''
        };
      })
    );

    const validEmails = emailSummaries
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (validEmails.length === 0) {
      return res.status(200).json({ tasks: [], waiting: [], fyi: [] });
    }

    const prompt = `You are triaging emails for Natasha Bradley, EA & Office Manager at 645 Ventures NYC.

Classify each email into exactly one of three categories:
- TASK: Natasha needs to take a specific action
- WAITING: Natasha is waiting for a response or action from someone else
- FYI: For awareness only, no action needed

EXCLUDE: automated notifications, marketing, newsletters, calendar invites already on calendar.

Emails:
${validEmails.map((e, i) => `${i+1}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n\n')}

Return ONLY valid JSON, no markdown:
{
  "tasks": [{"subject":string,"from":string,"act