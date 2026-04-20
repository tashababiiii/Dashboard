const { google } = require('googleapis');
const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');

const MY_CAL    = 'nbradley@645ventures.com';
const AARON_CAL = 'aholidayiii@645ventures.com';
const PERSONAL  = 'natashapbradley@gmail.com';
const FAYE_CAL  = '94neb5sfjc8fav7o848cpiip42a125nj@import.calendar.google.com';

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const tokenCookie = parseCookies(req)['gcal_tokens'];
  if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  try {
    let tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));

    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 300000) {
      try {
        tokens = await refreshTokenIfNeeded(tokens);
        const encoded = Buffer.from(JSON.stringify(tokens)).toString('base64');
        res.setHeader('Set-Cookie',
          `gcal_tokens=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
        );
      } catch(e) {
        res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
        return res.status(401).json({ error: 'Token expired', needsAuth: true });
      }
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const timeMin = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 18 * 60 * 60 * 1000).toISOString();

    const calendarIds = [
      { id: MY_CAL,    label: 'mine'     },
      { id: AARON_CAL, label: 'aaron'    },
      { id: PERSONAL,  label: 'personal' },
      { id: FAYE_CAL,  label: 'faye'     }
    ];

    const results = await Promise.allSettled(
      calendarIds.map(async ({ id, label }) => {
        const response = await calendar.events.list({
          calendarId: id, timeMin, timeMax,
          singleEvents: true, orderBy: 'startTime', maxResults: 20
        });
        return { label, events: response.data.items || [] };
      })
    );

    const calendarData = {};
    results.forEach((result, i) => {
      const label = calendarIds[i].label;
      calendarData[label] = result.status === 'fulfilled'
        ? result.value.events.map(ev => ({
            id: ev.id,
            title: ev.summary || '(No title)',
            start: ev.start?.dateTime
              ? new Date(ev.start.dateTime).toLocaleTimeString('en-US', {
                  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
                })
              : 'All day',
            end: ev.end?.dateTime
              ? new Date(ev.end.dateTime).toLocaleTimeString('en-US', {
                  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
                })
              : '',
            location: ev.location || '',
            allDay: !ev.start?.dateTime,
            startRaw: ev.start?.dateTime || ev.start?.date || '',
            date: ev.start?.dateTime
              ? new Date(ev.start.dateTime).toDateString()
              : (ev.start?.date ? new Date(ev.start.date + 'T00:00:00').toDateString() : '')
          }))
        : [];
    });

    return res.status(200).json({
      success: true,
      date: now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York'
      }),
      calendars: calendarData
    });

  } catch (error) {
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }
    return res.status(500).json({ error: 'Calendar fetch failed' });
  }
};