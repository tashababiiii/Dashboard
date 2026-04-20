const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tokenCookie = parseCookies(req)['gcal_tokens'];
  if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  try {
    let tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    try { tokens = await refreshTokenIfNeeded(tokens); } catch(e) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Two queries:
    // 1. Emails directly to/from Natasha in last 3 days (catches Aaron forwards, replies, tasks)
    // 2. Emails where she's CC'd from key people in last 3 days
    const [directRes, ccRes] = await Promise.allSettled([
      gmail.users.threads.list({
        userId: 'me',
        q: 'newer_than:3d -from:noreply -from:no-reply -from:notifications -from:mailer -category:promotions -category:social',
        maxResults: 20
      }),
      gmail.users.threads.list({
        userId: 'me',
        q: `newer_than:3d (from:aholidayiii@645ventures.com OR from:natasha.holiday@rbccm.com OR from:nnamdi@645ventures.com OR from:lquirk@645ventures.com) -from:noreply`,
        maxResults: 10
      })
    ]);

    // Merge thread IDs, deduplicate
    const seenIds = new Set();
    const allThreads = [];
    for (const result of [directRes, ccRes]) {
      if (result.status === 'fulfilled') {
        for (const t of (result.value.data.threads || [])) {
          if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            allThreads.push(t);
          }
        }
      }
    }

    if (allThreads.length === 0) return res.status(200).json({ items: [] });

    // Fetch metadata for each thread — get FULL snippet and sender
    const summaries = await Promise.allSettled(
      allThreads.slice(0, 20).map(async t => {
        const thread = await gmail.users.threads.get({
          userId: 'me', id: t.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date']
        });
        // Use latest message in thread
        const latest = thread.data.messages?.[thread.data.messages.length - 1];
        const headers = {};
        (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
        return {
          subject: (headers['Subject'] || '(no subject)').slice(0, 200),
          from: (headers['From'] || 'unknown').slice(0, 100),
          to: (headers['To'] || '').slice(0, 150),
          cc: (headers['Cc'] || '').slice(0, 150),
          snippet: (latest?.snippet || '').slice(0, 200)
        };
      })
    );

    const validEmails = summaries.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (validEmails.length === 0) return res.status(200).json({ items: [] });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Triage these emails for Natasha Bradley, EA & Office Manager at 645 Ventures NYC. She manages Aaron Holiday (Managing Partner). Flag anything that needs her action — including:
- Direct requests from Aaron (even if forwarded)
- Scheduling requests she's been CC'd on to coordinate
- Payment or invoice requests
- Time-sensitive items or things past due
- Anything where she needs to follow up or reply

Do NOT flag newsletters, automated system emails, or mass CC blasts with no action needed.

${validEmails.map((e, i) => `${i+1}. From: ${e.from}\nTo: ${e.to}\nCC: ${e.cc}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n\n')}

Return ONLY a valid JSON array of actionable items:
[{"title":"short action description under 8 words","reason":"exactly what needs to happen","subject":"email subject","from":"sender name/email"}]

If nothing needs action, return [].`
      }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
    let items = [];
    try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
    return res.status(200).json({ items: Array.isArray(items) ? items : [] });

  } catch (error) {
    console.error('Gmail scan error:', error.message);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }
    return res.status(500).json({ error: 'Scan failed', items: [] });
  }
};