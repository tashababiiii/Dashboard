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

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    const { dashboardState } = body || {};

    // Gather context: recent emails
    let emailContext = '';
    const cookies = parseCookies(req);
    const tokenCookie = cookies['gcal_tokens'];
    if (tokenCookie) {
      try {
        const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
        oauth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const listRes = await gmail.users.threads.list({
          userId: 'me',
          q: 'newer_than:2d -label:Unroll.me -from:unroll.me -from:noreply',
          maxResults: 15
        });
        const threads = listRes.data.threads || [];
        const summaries = await Promise.allSettled(
          threads.slice(0, 10).map(async t => {
            const thread = await gmail.users.threads.get({
              userId: 'me', id: t.id, format: 'metadata',
              metadataHeaders: ['Subject', 'From']
            });
            const msgs = thread.data.messages || [];
            const latest = msgs[msgs.length - 1];
            const headers = {};
            (latest?.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
            return `- ${headers['Subject'] || '(no subject)'} | from: ${headers['From'] || 'unknown'} | ${latest?.snippet?.substring(0, 100) || ''}`;
          })
        );
        emailContext = summaries.filter(r => r.status === 'fulfilled').map(r => r.value).join('\n');
      } catch(e) {
        emailContext = 'Email not available';
      }
    }

    // Build dashboard context from state
    const state = dashboardState || {};
    const tasks = (state.tasks || []).filter(t => !t.done).map(t => `[${t.tag}][${t.hz}][${t.priority}] ${t.title}${t.note ? ' — ' + t.note : ''}`).join('\n');
    const fayeTasks = (state.fayeTasks || []).filter(t => !t.done).map(t => `[FAYE/${t.client}][${t.hz}][${t.priority}] ${t.title}`).join('\n');
    const aaronTasks = (state.aaronTasks || []).filter(t => !t.done).map(t => `[AARON][${t.hz}][${t.priority}] ${t.title}${t.note ? ' — ' + t.note : ''}`).join('\n');
    const waiting = Object.entries(state.waitingOn || {}).map(([k, v]) => v.map(w => `[WAITING/${k.toUpperCase()}] ${w.person}: ${w.what} (since ${w.since})`).join('\n')).join('\n');

    const prompt = `You are Natasha Bradley's Chief of Staff AI. Natasha is EA & Office Manager at 645 Ventures NYC.

Her current dashboard:
TASKS:
${tasks || 'None'}

FAYE TASKS:
${fayeTasks || 'None'}

AARON QUEUE:
${aaronTasks || 'None'}

WAITING ON:
${waiting || 'None'}

RECENT EMAILS (last 48hrs):
${emailContext || 'Not available'}

TODAY: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Your job: identify small, EXECUTABLE tasks you can take off Natasha's plate RIGHT NOW. Only include tasks that:
1. Have a clear, specific action (not vague)
2. Can be completed with one of these tools: send email draft, create calendar event, add task to dashboard, send Slack message, log delegation
3. Are genuinely useful and time-sensitive
4. You have enough context to execute correctly

For each task, specify EXACTLY what you would do — be specific about content, recipient, timing.

Return ONLY valid JSON array (max 6 items):
[
  {
    "id": "unique_id_string",
    "title": "Short action title (under 8 words)",
    "description": "Exactly what I will do — be specific",
    "tool": "draft_email"|"calendar_event"|"add_task"|"slack_message"|"log_delegation",
    "priority": "high"|"med"|"low",
    "workspace": "645"|"faye"|"personal"|"aaron"|"strategic",
    "data": {
      // For draft_email: {"to": "email", "subject": "subject", "body": "full email body"}
      // For calendar_event: {"title": "title", "date": "YYYY-MM-DD", "time": "HH:MM", "duration_min": 30, "calendar": "nbradley@645ventures.com", "description": "notes"}
      // For add_task: {"title": "task title", "tag": "645"|"faye"|"personal"|"aaron"|"strategic", "hz": "today"|"week"|"month", "priority": "high"|"med"|"low", "note": "optional context"}
      // For slack_message: {"channel": "channel name or DM", "message": "full message text"}
      // For log_delegation: {"person": "name", "what": "what was delegated", "due": "YYYY-MM-DD or null", "workspace": "645"}
    }
  }
]

If nothing genuinely executable right now, return [].`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
    let items = [];
    try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}

    return res.status(200).json({ items });

  } catch (error) {
    console.error('Agent queue error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};