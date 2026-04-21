/**
 * /api/agent
 * Unified agent endpoint — handles both queue generation and execution.
 * POST { action: 'queue', dashboardState: {...} } → suggests actions
 * POST { action: 'execute', item: {...} }          → executes an action
 */

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SLACK_CHANNELS = {
  'general': 'C1P17H3GC', 'random': 'C1P1DG1B2',
  '645-firm-announcements': 'C93KX6L2W', '645-nyc': 'C08EW48HFPX',
  '645ops': 'CAFJYFWJ3', 'events': 'CAK4UDVC0',
  'investment-and-research': 'C01CS2AJDT5', 'portfolio-news': 'C014PK2GW9E'
};

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLen);
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 254;
}
function isValidDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}
function isValidTime(time) {
  return typeof time === 'string' && /^\d{2}:\d{2}$/.test(time);
}

// ── QUEUE: generate suggested actions ──────────────────────────────────────
async function handleQueue(body, req, res) {
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

  let emailContext = '';
  try {
    const cookies = parseCookies(req);
    const tokenCookie = cookies['gcal_tokens'];
    if (tokenCookie) {
      const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
      const oauth2Client = getOAuth2Client();
      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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
TASKS: ${tasks || 'None'}
AARON QUEUE: ${aaronTasks || 'None'}
FAYE CLIENT TASKS: ${fayeTasks || 'None'}
WAITING ON: ${waiting || 'None'}
${emailContext ? `RECENT EMAILS:\n${emailContext}` : ''}

YOUR JOB: Identify 3-5 specific, immediately executable actions to take off Natasha's plate right now.

IMPORTANT RULES:
1. You MUST return at least 3 items. Never return an empty array.
2. Each item must be something you can ACTUALLY DO — draft an email, create a calendar event, add a task, send a Slack message, or log a delegation.
3. Look at EVERY email snippet for action signals: "can you confirm", "can you pay", "can you schedule", past due invoices, scheduling requests.
4. Look at EVERY waiting item — if something has been waiting, draft a follow-up.
5. Be SPECIFIC with actual content — real email bodies, real dates, real subjects.
6. Prioritize: unread direct asks from Aaron > past due items > scheduling > follow-ups.

Return ONLY a valid JSON array, no markdown:
[{"id":"string","title":"Short title under 8 words","description":"Exactly what I will do","tool":"draft_email|calendar_event|add_task|slack_message|log_delegation","priority":"high|med|low","workspace":"645|faye|personal|aaron|strategic","data":{}}]

data shape per tool:
- draft_email: {"to":"email@domain.com","subject":"Re: Subject","body":"Full email body"}
- calendar_event: {"title":"Meeting Title","date":"YYYY-MM-DD","time":"HH:MM","duration_min":60,"calendar":"nbradley@645ventures.com","description":"notes"}
- add_task: {"title":"task","tag":"645|faye|personal|aaron|strategic","hz":"today|week|month","priority":"high|med|low","note":"context"}
- slack_message: {"channel":"general","message":"full message"}
- log_delegation: {"person":"Name","what":"what","due":"YYYY-MM-DD","workspace":"645"}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = message.content?.find(b => b.type === 'text')?.text || '[]';
  let items = [];
  try { items = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
  if (!Array.isArray(items)) items = [];

  // Safety net — if Claude returns empty, surface top pending tasks
  if (items.length === 0) {
    const topTasks = [
      ...(state.aaronTasks || []).filter(t => !t.done).slice(0, 2),
      ...(state.tasks || []).filter(t => !t.done && t.priority === 'high').slice(0, 1)
    ];
    items = topTasks.map((t, i) => ({
      id: `fallback-${i}`, title: t.title.slice(0, 40),
      description: `Add "${t.title}" as a today priority`,
      tool: 'add_task', priority: t.priority || 'med',
      workspace: t.tag === 'aaron' ? 'aaron' : (t.tag || '645'),
      data: { title: t.title, tag: t.tag || '645', hz: 'today', priority: t.priority || 'med', note: t.note || '' }
    }));
  }

  return res.status(200).json({ items });
}

// ── EXECUTE: run a suggested action ────────────────────────────────────────
async function handleExecute(body, req, res) {
  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  const { item } = body || {};
  if (!item || !item.tool) return res.status(400).json({ error: 'Missing item or tool' });

  const ALLOWED_TOOLS = ['draft_email', 'calendar_event', 'slack_message', 'add_task', 'log_delegation'];
  if (!ALLOWED_TOOLS.includes(item.tool)) return res.status(400).json({ error: `Unknown tool: ${item.tool}` });

  const d = item.data || {};

  if (item.tool === 'draft_email') {
    if (!isValidEmail(d.to)) return res.status(400).json({ error: 'Invalid email address' });
    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const raw = Buffer.from([
      `To: ${sanitize(d.to, 254)}`,
      `Subject: ${sanitize(d.subject || '(no subject)', 998)}`,
      `Content-Type: text/plain; charset=utf-8`,
      `MIME-Version: 1.0`,
      ``,
      sanitize(d.body || '', 10000)
    ].join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
    return res.status(200).json({
      success: true,
      action: 'draft_email',
      receipt: {
        to: d.to,
        subject: d.subject || '(no subject)',
        bodyPreview: (d.body || '').slice(0, 200),
        draftedAt: new Date().toISOString(),
        note: 'Saved to Gmail Drafts — review and send from Gmail'
      }
    });
  }

  if (item.tool === 'calendar_event') {
    if (!isValidDate(d.date)) return res.status(400).json({ error: 'Invalid date format' });
    if (d.time && !isValidTime(d.time)) return res.status(400).json({ error: 'Invalid time format' });
    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const startDateTime = new Date(`${d.date}T${d.time || '09:00'}:00`);
    if (isNaN(startDateTime.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
    const endDateTime = new Date(startDateTime.getTime() + (Math.min(Number(d.duration_min) || 30, 480)) * 60000);
    const allowedCalendars = ['nbradley@645ventures.com', 'natashapbradley@gmail.com'];
    const calendarId = allowedCalendars.includes(d.calendar) ? d.calendar : 'nbradley@645ventures.com';
    await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: sanitize(d.title || 'New Event', 500),
        description: sanitize(d.description || '', 2000),
        start: { dateTime: startDateTime.toISOString(), timeZone: 'America/New_York' },
        end: { dateTime: endDateTime.toISOString(), timeZone: 'America/New_York' }
      }
    });
    return res.status(200).json({
      success: true,
      action: 'calendar_event',
      receipt: {
        title: d.title || 'New Event',
        date: d.date,
        time: d.time || '09:00',
        duration: d.duration_min || 30,
        calendar: calendarId,
        createdAt: new Date().toISOString()
      }
    });
  }

  if (item.tool === 'slack_message') {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return res.status(401).json({ error: 'No Slack token configured' });
    const channelKey = (d.channel || '').replace('#', '').toLowerCase();
    const channelId = SLACK_CHANNELS[channelKey] || (/^[CU][A-Z0-9]+$/.test(d.channel) ? d.channel : null);
    if (!channelId) return res.status(400).json({ error: `Unknown Slack channel: ${d.channel}` });
    const messageText = sanitize(d.message || '', 3000);
    if (!messageText) return res.status(400).json({ error: 'Empty message' });
    // Post message to Slack
    const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channelId, text: messageText })
    });
    const msgData = await msgRes.json();
    if (!msgData.ok) throw new Error(`Slack error: ${msgData.error}`);
    // Return full receipt so dashboard can show confirmation
    return res.status(200).json({
      success: true,
      action: 'slack_message',
      receipt: {
        channel: d.channel || channelId,
        channelId,
        message: messageText,
        ts: msgData.ts,
        sentAt: new Date().toISOString()
      }
    });
  }

  // add_task and log_delegation are client-side
  if (item.tool === 'add_task' || item.tool === 'log_delegation') {
    return res.status(200).json({ success: true, action: item.tool, clientSide: true });
  }

  return res.status(400).json({ error: `Unhandled tool: ${item.tool}` });
}

// ── ROUTER ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!parseCookies(req)['gcal_tokens']) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);

    const action = body.action || 'queue';

    if (action === 'queue') return handleQueue(body, req, res);
    if (action === 'execute') return handleExecute(body, req, res);

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (error) {
    console.error('Agent error:', error.message);
    return res.status(500).json({ error: error.message, items: [] });
  }
};