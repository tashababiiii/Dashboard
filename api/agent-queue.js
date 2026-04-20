const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders, getOAuth2Client } = require('./_utils');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);

    const { dashboardState } = body || {};
    const state = dashboardState || {};

    const tasks = (state.tasks || []).filter(t => !t.done)
      .map(t => `[${t.tag}][${t.hz}][${t.priority}] ${t.title}${t.note ? ' — ' + t.note : ''}`).join('\n');
    const fayeTasks = (state.fayeTasks || []).filter(t => !t.done)
      .map(t => `[FAYE/${t.client}][${t.hz}][${t.priority}] ${t.title}`).join('\n');
    const aaronTasks = (state.aaronTasks || []).filter(t => !t.done)
      .map(t => `[AARON][${t.hz}][${t.priority}] ${t.title}${t.note ? ' — ' + t.note : ''}`).join('\n');
    const waiting = Object.entries(state.waitingOn || {})
      .map(([k, v]) => v.map(w => `[WAITING/${k.toUpperCase()}] ${w.person}: ${w.what}`).join('\n')).join('\n');

    let emailContext = '';
    try {
      const tokenCookie = parseCookies(req)['gcal_tokens'];
      if (tokenCookie) {
        const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
        const oauth2Client = getOAuth2Client();
        oauth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const listRes = await Promise.race([
          gmail.users.threads.list({
            userId: 'me', q: 'is:unread newer_than:7d -from:noreply', maxResults: 8
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        const threads = listRes.data.threads || [];
        const summaries = await Promise.allSettled(
          threads.slice(0, 4).map(async t => {
            const thread = await gmail.users.threads.get({
              userId: 'me', id: t.id, format: 'metadata',
              metadataHeaders: ['Subject', 'From']
            });
            const latest = thread.data.messages?.[thread.data.messages.length - 1];
            const headers = {};
            (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
            return `- ${headers['Subject'] || '(no subject)'} | from: ${headers['From'] || 'unknown'} | ${latest?.snippet?.substring(0, 80) || ''}`;
          })
        );
        emailContext = summaries.filter(r => r.status === 'fulfilled').map(r => r.value).join('\n');
      }
    } catch(e) { emailContext = ''; }

    const prompt = `You are Natasha Bradley's Chief of Staff AI. Natasha is EA & Office Manager at 645 Ventures NYC, working toward a Chief of Staff promotion.

TODAY: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

HER DASHBOARD:
TASKS: ${tasks || 'None'}
FAYE: ${fayeTasks || 'None'}
AARON QUEUE: ${aaronTasks || 'None'}
WAITING ON: ${waiting || 'None'}
${emailContext ? `RECENT EMAILS:\n${emailContext}` : ''}

Identify up to 5 small, EXECUTABLE tasks to take off her plate RIGHT NOW.

Rules:
- Only include tasks with clear, specific actions
- Only use these tools: draft_email, calendar_event, add_task, slack_message, log_delegation
- Be specific — include actual content, recipients, dates
- Prioritize high-impact items (time-sensitive, Aaron-related, or overdue)

Return ONLY a valid JSON array, no markdown, no comments:
[{"id":"string","title":"Short title under 8 words","description":"Exactly what I will do","tool":"draft_email|calendar_event|add_task|slack_message|log_delegation","priority":"high|med|low","workspace":"645|faye|personal|aaron|strategic","data":{}}]

data shape per tool:
- draft_email: {"to":"email","subject":"subject","body":"full body"}
- calendar_event: {"title":"title","date":"YYYY-MM-DD","time":"HH:MM","duration_min":30,"calendar":"nbradley@645ventures.com","description":"notes"}
- add_task: {"title":"title","tag":"645|faye|personal|aaron|strategic","hz":"today|week|month","priority":"high|med|low","note":"context"}
- slack_message: {"channel":"channel","message":"full message"}
- log_delegation: {"person":"name","what":"what","due":"YYYY-MM-DD or null","workspace":"645"}

If nothing executable, return [].`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
    let items = [];
    try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}

    return res.status(200).json({ items: Array.isArray(items) ? items : [] });

  } catch (error) {
    console.error('Agent queue error:', error.message);
    return res.status(500).json({ error: error.message, items: [] });
  }
};