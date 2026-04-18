const { google } = require('googleapis');

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

  try {
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);
    const { item } = body || {};
    if (!item) return res.status(400).json({ error: 'Missing item' });

    const d = item.data || {};
    const isScheduled = !!d.scheduledAt;
    const scheduledDate = isScheduled ? new Date(d.scheduledAt) : null;

    // ── DRAFT EMAIL (or scheduled send) ──
    if (item.tool === 'draft_email') {
      const cookies = parseCookies(req);
      const tokenCookie = cookies['gcal_tokens'];
      if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

      const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const emailLines = [
        `To: ${d.to}`,
        `Subject: ${d.subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        d.body || ''
      ];
      const raw = Buffer.from(emailLines.join('\n'))
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      if (isScheduled && scheduledDate) {
        // Gmail doesn't have native schedule API — create draft with schedule note
        // We'll create a draft and add a note about when to send
        await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw } }
        });
        return res.status(200).json({
          success: true,
          action: 'draft_email_scheduled',
          to: d.to,
          subject: d.subject,
          scheduledAt: d.scheduledAt,
          note: `Draft created — scheduled to send ${scheduledDate.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}. Open Gmail Drafts to review and send.`
        });
      } else {
        await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw } }
        });
        return res.status(200).json({ success: true, action: 'draft_email', to: d.to, subject: d.subject });
      }
    }

    // ── CALENDAR EVENT ──
    if (item.tool === 'calendar_event') {
      const cookies = parseCookies(req);
      const tokenCookie = cookies['gcal_tokens'];
      if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

      const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
      oauth2Client.setCredentials(tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const startDateTime = new Date(`${d.date}T${d.time || '09:00'}:00`);
      const endDateTime = new Date(startDateTime.getTime() + (d.duration_min || 30) * 60000);

      await calendar.events.insert({
        calendarId: d.calendar || 'nbradley@645ventures.com',
        requestBody: {
          summary: d.title,
          description: d.description || item.description,
          start: { dateTime: startDateTime.toISOString(), timeZone: 'America/New_York' },
          end: { dateTime: endDateTime.toISOString(), timeZone: 'America/New_York' }
        }
      });
      return res.status(200).json({ success: true, action: 'calendar_event', title: d.title });
    }

    // ── SLACK MESSAGE (with optional schedule) ──
    if (item.tool === 'slack_message') {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return res.status(401).json({ error: 'No Slack token' });

      // Find channel ID
      const searchRes = await fetch(
        `https://slack.com/api/conversations.list?limit=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const searchData = await searchRes.json();
      const channel = (searchData.channels || []).find(c =>
        c.name === d.channel || c.id === d.channel || c.name === d.channel?.replace('#','')
      );
      const channelId = channel?.id || d.channel;

      if (isScheduled && scheduledDate) {
        // Use Slack's native schedule message API
        const postAt = Math.floor(scheduledDate.getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);

        if (postAt < now + 120) {
          return res.status(400).json({ error: 'Scheduled time must be at least 2 minutes in the future' });
        }

        const schedRes = await fetch('https://slack.com/api/chat.scheduleMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: channelId, text: d.message, post_at: postAt })
        });
        const schedData = await schedRes.json();
        if (!schedData.ok) throw new Error(`Slack schedule error: ${schedData.error}`);
        return res.status(200).json({
          success: true,
          action: 'slack_scheduled',
          channel: d.channel,
          scheduledAt: d.scheduledAt,
          note: `Message scheduled for ${scheduledDate.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`
        });
      } else {
        // Send immediately
        const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: channelId, text: d.message })
        });
        const msgData = await msgRes.json();
        if (!msgData.ok) throw new Error(`Slack error: ${msgData.error}`);
        return res.status(200).json({ success: true, action: 'slack_message', channel: d.channel });
      }
    }

    return res.status(400).json({ error: `Unknown tool: ${item.tool}` });

  } catch (error) {
    console.error('Agent execute error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};