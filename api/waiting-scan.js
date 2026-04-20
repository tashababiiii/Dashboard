/**
 * /api/waiting-scan
 * Scans inbox-only emails and identifies threads where Natasha is waiting on someone.
 * Uses in:inbox only — she uses her inbox as a to-do/tracker.
 * Does NOT filter noreply — inbox may have actionable automated emails.
 */

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);
    await refreshTokenIfNeeded(oauth2Client, req, res);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Inbox only — no noreply filter — she uses inbox as tracker
    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q: 'in:inbox newer_than:14d -category:promotions -category:social',
      maxResults: 25
    });

    const threads = listRes.data.threads || [];
    if (!threads.length) return res.status(200).json({ items: [] });

    // Fetch thread metadata in parallel
    const threadDetails = await Promise.allSettled(
      threads.map(async t => {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: t.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date']
        });
        const messages = thread.data.messages || [];
        const latest = messages[messages.length - 1];
        const headers = {};
        (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
        const lastSender = headers['From'] || '';
        const isFromMe = lastSender.toLowerCase().includes('nbradley') ||
                         lastSender.toLowerCase().includes('natasha bradley');
        return {
          subject: headers['Subject'] || '(no subject)',
          from: headers['From'] || '',
          lastSender,
          isFromMe, // last message was sent by Natasha = likely waiting for reply
          messageCount: messages.length,
          snippet: latest?.snippet?.substring(0, 150) || ''
        };
      })
    );

    const validThreads = threadDetails
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .slice(0, 20);

    // Let Claude identify which threads represent waiting-on items
    const threadSummaries = validThreads.map((t, i) =>
      `[${i}] Subject: "${t.subject}" | From: ${t.from} | Last sender was ${t.isFromMe ? 'NATASHA (she replied last — likely waiting)' : 'THEM'} | Snippet: "${t.snippet}"`
    ).join('\n');

    const prompt = `You are analyzing Natasha Bradley's inbox (EA at 645 Ventures NYC). She uses her inbox as a to-do list and tracker.

Review these inbox threads and identify ONLY the ones where Natasha is clearly waiting on someone else to respond or act. Signs she's waiting:
- She sent the last message (marked "NATASHA replied last")
- Scheduling coordination pending a response
- A direct ask or request sent to someone
- Invoice, document, or confirmation pending
- An intro she's following up on

Do NOT include:
- Marketing or newsletter emails
- Automated confirmations that need no reply
- Internal calendar invites
- Threads where the other person replied last and it looks resolved

INBOX THREADS:
${threadSummaries}

Return ONLY a valid JSON array of waiting items, no markdown:
[{"index": 0, "from": "Person Name or org", "subject": "subject line", "what": "Short description of what she is waiting on (max 12 words)"}]

Return an empty array [] if nothing qualifies. Maximum 8 items.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
    let items = [];
    try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
    if (!Array.isArray(items)) items = [];

    // Clean up and return
    const result = items
      .filter(item => typeof item.index === 'number' && validThreads[item.index])
      .map(item => ({
        from: item.from || validThreads[item.index]?.from || '',
        subject: item.subject || validThreads[item.index]?.subject || '',
        what: item.what || ''
      }));

    return res.status(200).json({ items: result });

  } catch (error) {
    console.error('waiting-scan error:', error.message);
    return res.status(500).json({ error: error.message, items: [] });
  }
};