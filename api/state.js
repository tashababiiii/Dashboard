// /api/state.js — Cross-device state sync via Vercel KV (Redis)
// GET  /api/state  → returns saved state
// POST /api/state  → saves state

const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');
const { google } = require('googleapis');

const STATE_TTL = 60 * 60 * 24 * 90; // 90 days
const ALLOWED_EMAILS = ['nbradley@645ventures.com', 'natashapbradley@gmail.com'];

async function getKV() {
  const { kv } = await import('@vercel/kv');
  return kv;
}

async function getUserEmail(req) {
  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) return null;

  let tokens;
  try { tokens = JSON.parse(tokenCookie); } catch(e) { return null; }

  // If email was cached in the token object, use it directly
  if (tokens.email && ALLOWED_EMAILS.includes(tokens.email)) return tokens.email;

  // Otherwise fetch from Google userinfo (same as auth.js does)
  try {
    const client = getOAuth2Client();
    tokens = await refreshTokenIfNeeded(tokens);
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    return data.email?.toLowerCase() || null;
  } catch(e) {
    console.error('[state] getUserEmail failed:', e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = await getUserEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  if (!ALLOWED_EMAILS.includes(email)) return res.status(403).json({ error: 'Forbidden' });

  const key = `dashboard:state:${email.replace(/[^a-z0-9@._-]/gi, '_')}`;

  try {
    const kv = await getKV();

    if (req.method === 'GET') {
      const state = await kv.get(key);
      return res.status(200).json({ state: state || null });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {
          return res.status(400).json({ error: 'Invalid JSON' });
        }
      }
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body must be JSON object' });
      }

      const stateStr = JSON.stringify(body);
      if (stateStr.length > 512 * 1024) {
        return res.status(413).json({ error: 'State too large (max 512KB)' });
      }

      body._savedAt = Date.now();
      await kv.set(key, body, { ex: STATE_TTL });
      return res.status(200).json({ ok: true, savedAt: body._savedAt });
    }

    if (req.method === 'DELETE') {
      await kv.del(key);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[state] KV error:', error.message);
    if (req.method === 'GET') return res.status(200).json({ state: null, kvError: true });
    return res.status(500).json({ error: 'State sync unavailable' });
  }
};