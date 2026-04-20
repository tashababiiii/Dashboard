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

    // Parse body — check for quick mode flag (used by Smart Sync for speed)
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);
    const isQuick = !!(body?.quick);

    // Quick mode (Smart Sync): only key people, last 1 day, fewer threads
    // Full mode (Email Scan): broad inbox + key people, last 3 days, more threads
    const [broadRes, keyPeopleRes] = await Promise.allSettled([
      isQuick ? Promise.resolve({ data: { threads: [] } }) : gmail.users.threads.list({
        userId: 'me',
        q: 'newer_than:3d -from:noreply -from:no-reply -from:notifications@ -from:mailer@ -category:promotions -category:social',
        maxResults: 20
      }),
      gmail.users.threads.list({
        userId: 'me',
        q: `newer_than:${isQuick ? '1d' : '7d'} (from:aholidayiii@645ventures.com OR from:natasha.holiday@rbccm.com OR from:nnamdi@645ventures.com OR from:lquirk@645ventures.com OR from:khardeman@645ventures.com)`,
        maxResults: isQuick ? 8 : 15
      })
    ]);

    // Merge and deduplicate thread IDs
    const seenIds = new Set();
    const allThreads = [];
    for (const result of [broadRes, keyPeopleRes]) {
      if (result.status === 'fulfilled') {
        for (const t of (result.value.data?.threads || [])) {
          if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            allThreads.push(t);
          }
        }
      }
    }

    if (allThreads.length === 0) return res.status(200).json({ tasks: [], waiting: [], fyi: [] });

    // Fetch metadata — quick mode fetches fewer threads
    const summaries = await Promise.allSettled(
      allThreads.slice(0, isQuick ? 8 : 25).map(async t => {
        const thread = await gmail.users.threads.get({
          userId: 'me', id: t.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date']
        });
        const latest = thread.data.messages?.[thread.data.messages.length - 1];
        const headers = {};
        (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
        return {
          subject: (headers['Subject'] || '(no subject)').slice(0, 200),
          from: (headers['From'] || 'unknown').slice(0, 100),
          to: (headers['To'] || '').slice(0, 150),
          cc: (headers['Cc'] || '').slice(0, 150),
          snippet: (latest?.snippet || '').slice(0, 250)
        };
      })
    );

    const validEmails = summaries.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (validEmails.length === 0) return res.status(200).json({ tasks: [], waiting: [], fyi: [] });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: isQuick ? 800 : 2000,
      messages: [{
        role: 'user',
        content: `Triage these emails for Natasha Bradley, EA & Office Manager at 645 Ventures NYC.
She manages Aaron Holiday (Co-founder & Managing Partner). Her email is nbradley@645ventures.com.

Classify each actionable email into one of three buckets:

TASKS — emails where Natasha needs to DO something (reply, register, pay, schedule, follow up, confirm, coordinate)
WAITING — emails where she is waiting for someone else to respond or act
FYI — emails that are informational but worth noting (no action needed)

Key signals to flag:
- Aaron forwarding something with "can you..." or "please..." = TASK
- Anyone asking her to schedule, coordinate, or confirm = TASK  
- Invoices or payment requests = TASK (high priority)
- She CC'd on something where someone said she'll coordinate = TASK
- Thread where she's waiting for a reply from someone = WAITING
- Important context emails about deals, LPs, events = FYI

Exclude: mass CC blasts with no action needed, newsletters, automated system emails.

${validEmails.map((e, i) => `${i+1}. From: ${e.from}\nTo: ${e.to}\nCC: ${e.cc}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n\n')}

Return ONLY valid JSON:
{
  "tasks": [{"action":"what Natasha needs to do (specific)","subject":"email subject","from":"sender name","priority":"high|med|low","workspace":"645|faye|personal|aaron|strategic"}],
  "waiting": [{"waiting_for":"what she is waiting on","subject":"email subject","from":"who she is waiting on","since":"today"}],
  "fyi": [{"summary":"one sentence summary","subject":"email subject","from":"sender name"}]
}

If a bucket is empty return []. Be specific in action descriptions — not "respond to email" but "Register Aaron for Power100 Honoree Dinner".`
      }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '{}';
    let result = { tasks: [], waiting: [], fyi: [] };
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      result.tasks   = Array.isArray(parsed.tasks)   ? parsed.tasks   : [];
      result.waiting = Array.isArray(parsed.waiting) ? parsed.waiting : [];
      result.fyi     = Array.isArray(parsed.fyi)     ? parsed.fyi     : [];
    } catch(e) {}

    return res.status(200).json(result);

  } catch (error) {
    console.error('Gmail scan error:', error.message);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }
    return res.status(500).json({ error: 'Scan failed', tasks: [], waiting: [], fyi: [] });
  }
};