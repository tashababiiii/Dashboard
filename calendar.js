const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Calendar IDs
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
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  // Parse token from cookie
  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  
  if (!tokenCookie) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }
  
  try {
    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    oauth2Client.setCredentials(tokens);
    
    // Auto-refresh if token expired
    oauth2Client.on('tokens', (newTokens) => {
      if (newTokens.refresh_token) {
        tokens.refresh_token = newTokens.refresh_token;
      }
      tokens.access_token = newTokens.access_token;
    });
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Time range: today
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    
    const timeMin = startOfDay.toISOString();
    const timeMax = endOfDay.toISOString();
    
    // Fetch from all calendars in parallel
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
        return { label, events: response.data.items || [] };
      })
    );
    
    // Process results
    const calendarData = {};
    results.forEach((result, i) => {
      const label = calendarIds[i].label;
      if (result.status === 'fulfilled') {
        calendarData[label] = result.value.events.map(ev => ({
          id: ev.id,
          title: ev.summary || '(No title)',
          start: ev.start?.dateTime 
            ? new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
            : 'All day',
          end: ev.end?.dateTime
            ? new Date(ev.end.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
            : '',
          location: ev.location || '',
          description: ev.description || '',
          allDay: !ev.start?.dateTime,
          startRaw: ev.start?.dateTime || ev.start?.date || ''
        }));
      } else {
        calendarData[label] = [];
      }
    });
    
    return res.status(200).json({
      success: true,
      date: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
      calendars: calendarData
    });
    
  } catch (error) {
    console.error('Calendar fetch error:', error);
    
    // If token is invalid, tell client to re-auth
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }
    
    return res.status(500).json({ error: error.message });
  }
};
