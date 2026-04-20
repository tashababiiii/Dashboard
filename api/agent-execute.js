const { google } = require('googleapis');
const { parseCookies, setCorsHeaders, getOAuth2Client } = require('./_utils');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Known Slack channel IDs — use these directly instead of fetching all channels
const SLACK_CHANNELS = {
  'general': 'C1P17H3GC', 'random': 'C1P1DG1B2',
  '645-firm-announcements': 'C93KX6L2W', '645-nyc': 'C08EW48HFPX',
  '645ops': 'CAFJYFWJ3', 'events': 'CAK4UDVC0',
  'engineering': 'C0494CJT3V2', 'investment-and-research': 'C01CS2AJDT5',
  'portfolio-news': 'C014PK2GW9E'
};


// Sanitize a string — strip control characters that enable header injection
function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLen);
}

// Validate email address format
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 254;
}

// Validate date format YYYY-MM-DD
function isValidDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

// Validate time format HH:MM
function isValidTime(time) {
  return typeof time === 'string' && /^\d{2}:\d{2}$/.test(time);
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Always require auth cookie
  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  try {
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);

    const { item } = body || {};
    if (!item || !item.tool) return res.status(400).json({ error: 'Missing item or tool' });

    // Whitelist allowed tools
    const ALLOWED_TOOLS = ['draft_email', 'calendar_event', 'slack_message', 'add_task', 'log_delegation'];
    if (!ALLOWED_TOOLS.includes(item.tool)) {
      return res.status(400).json({ error: `Unknown tool: ${item.tool}` });
    }

    const d = item.data || {};

    // ── DRAFT EMAIL ────────────────────────────────────────────────
    if (item.tool === 'draft_email') {
      if (!isValidEmail(d.to)) return res.status(400).json({ error: 'Invalid email address' });

      const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
      const oauth2Client = getOAuth2Client();
      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // Sanitize all fields to prevent header injection
      const to      = sanitize(d.to, 254);
      const subject = sanitize(d.subject || '(no subject)', 998);
      const body    = sanitize(d.body || '', 10000);

      const emailLines = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        `MIME-Version: 1.0`,
        ``,
        body
      ];

      const raw = Buffer.from(emailLines.join('\r\n'))
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw } }
      });

      return res.status(200).json({ success: true, action: 'draft_email', to, subject });
    }

    // ── CALENDAR EVENT ─────────────────────────────────────────────
    if (item.tool === 'calendar_event') {
      if (!isValidDate(d.date)) return res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
      if (d.time && !isValidTime(d.time)) return res.status(400).json({ error: 'Invalid time format — use HH:MM' });

      const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
      const oauth2Client = getOAuth2Client();
      oauth2Client.setCredentials(tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const startDateTime = new Date(`${d.date}T${d.time || '09:00'}:00`);
      if (isNaN(startDateTime.getTime())) return res.status(400).json({ error: 'Invalid date/time' });

      const endDateTime = new Date(startDateTime.getTime() + (Math.min(Number(d.duration_min) || 30, 480)) * 60000);

      // Whitelist calendar ID
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

      return res.status(200).json({ success: true, action: 'calendar_event', title: d.title });
    }

    // ── SLACK MESSAGE ──────────────────────────────────────────────
    if (item.tool === 'slack_message') {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return res.status(401).json({ error: 'No Slack token configured' });

      // Resolve channel — use known IDs first, fall back to provided ID with validation
      const channelKey = (d.channel || '').replace('#', '').toLowerCase();
      const channelId = SLACK_CHANNELS[channelKey] || (
        /^[CU][A-Z0-9]+$/.test(d.channel) ? d.channel : null
      );
      if (!channelId) return res.status(400).json({ error: `Unknown Slack channel: ${d.channel}` });

      const messageText = sanitize(d.message || '', 3000);
      if (!messageText) return res.status(400).json({ error: 'Empty message' });

      const isScheduled = !!d.scheduledAt;
      if (isScheduled) {
        const scheduledDate = new Date(d.scheduledAt);
        if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: 'Invalid scheduledAt date' });

        const postAt = Math.floor(scheduledDate.getTime() / 1000);
        const now    = Math.floor(Date.now() / 1000);
        if (postAt < now + 120) return res.status(400).json({ error: 'Scheduled time must be at least 2 minutes in the future' });

        const schedRes = await fetch('https://slack.com/api/chat.scheduleMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: channelId, text: messageText, post_at: postAt })
        });
        const schedData = await schedRes.json();
        if (!schedData.ok) throw new Error(`Slack schedule error: ${schedData.error}`);
        return res.status(200).json({ success: true, action: 'slack_scheduled', channel: d.channel });
      } else {
        const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: channelId, text: messageText })
        });
        const msgData = await msgRes.json();
        if (!msgData.ok) throw new Error(`Slack error: ${msgData.error}`);
        return res.status(200).json({ success: true, action: 'slack_message', channel: d.channel });
      }
    }

    // add_task and log_delegation are handled client-side in the dashboard
    if (item.tool === 'add_task' || item.tool === 'log_delegation') {
      return res.status(200).json({ success: true, action: item.tool, clientSide: true });
    }

    return res.status(400).json({ error: `Unhandled tool: ${item.tool}` });

  } catch (error) {
    console.error('Agent execute error:', error.message);
    return res.status(500).json({ error: 'Execution failed' });
  }
};