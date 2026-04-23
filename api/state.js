// /api/state.js — Cross-device state sync using REDIS_URL (standard Redis)
// GET  /api/state        → returns saved state
// POST /api/state        → saves state  
// GET  /api/state?debug  → diagnostic info

const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');
const { google } = require('googleapis');

const STATE_TTL = 60 * 60 * 24 * 90; // 90 days in seconds
const ALLOWED_EMAILS = ['nbradley@645ventures.com', 'natashapbradley@gmail.com'];

// Lazy Redis client — created once and reused across warm invocations
let _redis = null;
async function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL env var not set');
  const Redis = require('ioredis');
  _redis = new Redis(url, { 
    tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
  });
  await _redis.connect().catch(() => {}); // connect eagerly, ignore if already connected
  return _redis;
}

async function getUserEmail(req) {
  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) return { email: null, step: 'no_cookie' };

  let tokens;
  try {
    const decoded = Buffer.from(tokenCookie, 'base64').toString('utf8');
    tokens = JSON.parse(decoded);
  } catch(e) {
    try { tokens = JSON.parse(tokenCookie); }
    catch(e2) { return { email: null, step: 'cookie_parse_failed' }; }
  }

  if (!tokens || typeof tokens !== 'object') return { email: null, step: 'tokens_not_object' };

  // Email stored in token by updated auth.js
  if (tokens.email) {
    const email = tokens.email.toLowerCase();
    if (ALLOWED_EMAILS.includes(email)) return { email, step: 'from_token' };
    return { email: null, step: 'email_not_allowed' };
  }

  // Fallback: fetch from Google userinfo for old sessions
  if (!tokens.access_token) return { email: null, step: 'no_access_token' };
  try {
    const client = getOAuth2Client();
    const refreshed = await refreshTokenIfNeeded(tokens);
    client.setCredentials(refreshed);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    const email = data.email?.toLowerCase();
    if (!email) return { email: null, step: 'userinfo_no_email' };
    if (!ALLOWED_EMAILS.includes(email)) return { email: null, step: 'email_not_allowed' };
    return { email, step: 'from_google_userinfo' };
  } catch(e) {
    return { email: null, step: 'userinfo_failed', hint: e.message };
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Debug endpoint
  if (req.method === 'GET' && req.query?.debug !== undefined) {
    const { email, step, hint } = await getUserEmail(req);
    const hasRedisUrl = !!process.env.REDIS_URL;
    let redisOk = false, redisError = null;
    if (hasRedisUrl) {
      try { const r = await getRedis(); await r.ping(); redisOk = true; }
      catch(e) { redisError = e.message; }
    }
    return res.status(200).json({
      authStep: step, authHint: hint || null, authed: !!email,
      redisUrlSet: hasRedisUrl, redisConnected: redisOk, redisError,
    });
  }

  const { email, step } = await getUserEmail(req);
  if (!email) {
    console.error(`[state] Auth failed: ${step}`);
    return res.status(401).json({ error: 'Not authenticated', step });
  }

  const key = `dashboard:${email.replace(/[^a-z0-9@._-]/gi, '_')}`;

  try {
    const redis = await getRedis();

    if (req.method === 'GET') {
      const raw = await redis.get(key);
      if (!raw) return res.status(200).json({ state: null });
      return res.status(200).json({ state: JSON.parse(raw) });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {
          return res.status(400).json({ error: 'Invalid JSON body' });
        }
      }
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body must be JSON object' });
      }
      const stateStr = JSON.stringify(body);
      if (stateStr.length > 512 * 1024) {
        return res.status(413).json({ error: 'State too large — max 512KB' });
      }
      body._savedAt = Date.now();
      await redis.setex(key, STATE_TTL, JSON.stringify(body));
      return res.status(200).json({ ok: true, savedAt: body._savedAt });
    }

    if (req.method === 'DELETE') {
      const redis = await getRedis();
      await redis.del(key);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[state] Redis error:', error.message);
    if (req.method === 'GET') return res.status(200).json({ state: null, redisError: error.message });
    return res.status(500).json({ error: 'State sync failed', detail: error.message });
  }
};