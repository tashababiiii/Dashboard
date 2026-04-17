const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const MY_CAL = 'nbradley@645ventures.com';
const AARON_CAL = 'aholidayiii@645ventures.com';
const PERSONAL_CAL = 'natashapbradley@gmail.com';
const FAYE_CAL = '94neb5sfjc8fav7o848cpiip42a125nj@import.calendar.google.com';

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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];

  if (!tokenCookie) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    console.log('Server time (UTC):', now.toISOString());

    // Use a very wide window to catch all NY timezone events
    const timeMin = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 18 * 60 * 60 * 1000).toISOString();

    console.log('timeMin:', timeMin, 'timeMax:', timeMax);

    const calendarIds = [
      { id: MY_CAL, label: 'mine' },
      { id: AARON_CAL, label: 'aaron' },
      { id: PERSONAL_CAL, label: 'personal' },
      { id: FAYE_CAL, label: 'faye' }
    ];

    const results = await Promise.allSettled(
      calendarIds.map(async ({ id, label }) => {
        const response = await calendar.events.list({
          calendarId: id,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 20
        });
        const items = response.data.items || [];
        console.log(`${label}: ${items.length} events`);
        return { label, events: items };
      })
    );

    const calendarData = {};
    results.forEach((result, i) => {
      const label = calendarIds[i].label;
      if (result.status === 'fulfilled') {
        calendarData[label] = result.value.events.map(ev => ({
          id: ev.id,
          title: ev.summary || '(No title)',
          start: ev.start?.dateTime
            ? new Date(ev.start.dateTime).toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', hour12: true,
                timeZone: 'America/New_York'
              })
            : 'All day',
          end: ev.end?.dateTime
            ? new Date(ev.end.dateTime).toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', hour12: true,
                timeZone: 'America/New_York'
              })
            : '',
          location: ev.location || '',
          allDay: !ev.start?.dateTime,
          startRaw: ev.start?.dateTime || ev.start?.date || ''
        }));
      } else {
        console.error(`${label} failed:`, result.reason?.message || result.reason);
        calendarData[label] = [];
      }
    });

    return res.status(200).json({
      success: true,
      date: now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        timeZone: 'America/New_York'
      }),
      calendars: calendarData
    });

  } catch (error) {
    console.error('Top level error:', error.message);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }
    return res.status(500).json({ error: error.message });
  }
};