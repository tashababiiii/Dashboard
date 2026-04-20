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
      .map(([k, v]) => (v || []).map(w => `[WAITING/${k.toUpperCase()}] ${w.person}: ${w.what}`).join('\n')).join('\n');

    // Get recent emails with broad query to find actionable threads
    let emailContext = '';
    try {
      const cookies = parseCookies(req);
      const tokenCookie = cookies['gcal_tokens'];
      if (tokenCookie) {
        const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
        const oauth2Client = getOAuth2Client();
        oauth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Two targeted queries: key people + direct asks to Natasha
        const [keyPeopleRes, directRes] = await Promise.allSettled([
          Promise.race([
            gmail.users.threads.list({
              userId: 'me',
              q: 'newer_than:7d (from:aholidayiii@645ventures.com OR from:natasha.holiday@rbccm.com) -subject:"Private Invite"',
              maxResults: 6
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
          ]),
          Promise.race([
            gmail.users.threads.list({
              userId: 'me',
              q: 'newer_than:3d to:nbradley@645ventures.com is:unread -from:noreply -category:promotions',
              maxResults: 4
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
          ])
        ]);

        const seenIds = new Set();
        const allThreads = [];
        for (const result of [keyPeopleRes, directRes]) {
          if (result.status === 'fulfilled') {
            for (const t of (result.value.data?.threads || [])) {
              if (!seenIds.has(t.id)) { seenIds.add(t.id); allThreads.push(t); }
            }
          }
        }

        const summaries = await Promise.allSettled(
          allThreads.slice(0, 6).map(async t => {
            const thread = await gmail.users.threads.get({
              userId: 'me', id: t.id, format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'To']
            });
            const latest = thread.data.messages?.[thread.data.messages.length - 1];
            const headers = {};
            (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
            return `- From: ${(headers['From'] || '').slice(0, 60)} | Subject: ${(headers['Subject'] || '').slice(0, 80)} | "${(latest?.snippet || '').slice(0, 120)}"`;
          })
        );
        emailContext = summaries.filter(r => r.status === 'fulfilled').map(r => r.value).join('\n');
      }
    } catch(e) { emailContext = ''; }

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const prompt = `You are Natasha Bradley's Chief of Staff AI. Natasha is EA & Office Manager at 645 Ventures NYC, managing Aaron Holiday (Co-founder & Managing Partner). She is working toward a Chief of Staff promotion.

TODAY: ${today}

DASHBOARD STATE:
TASKS (her plate): 
${tasks || 'None'}

AARON QUEUE (things Aaron needs her to handle):
${aaronTasks || 'None'}

FAYE CLIENT TASKS:
${fayeTasks || 'None'}

WAITING ON:
${waiting || 'None'}

RECENT EMAILS FROM KEY PEOPLE:
${emailContext || 'None available'}

YOUR JOB: Identify 3-5 specific, immediately executable actions to take off Natasha's plate right now.

IMPORTANT RULES:
1. You MUST return at least 3 items. Never return an empty array.
2. Each item must be something you can ACTUALLY DO — draft an email, create a calendar event, add a task, send a Slack message, or log a delegation.
3. Look at EVERY email snippet for action signals: "can you confirm", "can you pay", "can you schedule", "can you look into", "I'm looping in Natasha", "important prospective LP", past due invoices, scheduling requests.
4. Look at EVERY waiting item — if something has been waiting, draft a follow-up.
5. Look at EVERY Aaron queue item — if it's a scheduling task, create the calendar event or draft the email.
6. Be SPECIFIC with actual content — real email bodies, real dates, real subjects. Not placeholders.
7. Prioritize: unread direct asks from Aaron > past due items > scheduling > follow-ups.

Return ONLY a valid JSON array, no markdown:
[{"id":"string","title":"Short title under 8 words","description":"Exactly what I will do","tool":"draft_email|calendar_event|add_task|slack_message|log_delegation","priority":"high|med|low","workspace":"645|faye|personal|aaron|strategic","data":{}}]

data shape per tool:
- draft_email: {"to":"email@domain.com","subject":"Re: Subject Line","body":"Full professional email body"}
- calendar_event: {"title":"Meeting Title","date":"YYYY-MM-DD","time":"HH:MM","duration_min":60,"calendar":"nbradley@645ventures.com","description":"context notes"}
- add_task: {"title":"task title","tag":"645|faye|personal|aaron|strategic","hz":"today|week|month","priority":"high|med|low","note":"why this matters"}
- slack_message: {"channel":"general","message":"full message text"}
- log_delegation: {"person":"Name","what":"what they need to do","due":"YYYY-MM-DD","workspace":"645"}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
    let items = [];
    try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
    if (!Array.isArray(items)) items = [];

    // Safety net — if Claude still returns empty, surface the top pending items as add_task
    if (items.length === 0) {
      const topTasks = [
        ...(state.aaronTasks || []).filter(t => !t.done).slice(0, 2),
        ...(state.tasks || []).filter(t => !t.done && t.priority === 'high').slice(0, 1)
      ];
      items = topTasks.map((t, i) => ({
        id: `fallback-${i}`,
        title: t.title.slice(0, 40),
        description: `Add "${t.title}" as a today priority`,
        tool: 'add_task',
        priority: t.priority || 'med',
        workspace: t.tag === 'aaron' ? 'aaron' : (t.tag || '645'),
        data: { title: t.title, tag: t.tag || '645', hz: 'today', priority: t.priority || 'med', note: t.note || '' }
      }));
    }

    return res.status(200).json({ items });

  } catch (error) {
    console.error('Agent queue error:', error.message);
    return res.status(500).json({ error: error.message, items: [] });
  }
};