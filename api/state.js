// /api/state.js — Cross-device state sync via Vercel KV REST API
// Uses fetch() directly — no @vercel/kv package needed
// GET  /api/state        → returns saved state
// POST /api/state        → saves state
// GET  /api/state?debug  → diagnostic info

const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');
const { google } = require('googleapis');

const STATE_TTL = 60 * 60 * 24 * 90; // 90 days in seconds
const ALLOWED_EMAILS = ['nbradley@645ventures.com', 'natashapbradley@gmail.com'];

// Call Vercel KV REST API directly — no SDK needed
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env vars not set');
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`KV GET failed: ${r.status}`);
  const { result } = await r.json();
  if (!result) return null;
  return typeof result === 'string' ? JSON.parse(result) : result;
}

async function kvSet(key, value, ttl) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env vars not set');
  const body = ttl
    ? ['SET', key, JSON.stringify(value), 'EX', ttl]
    : ['SET', key, JSON.stringify(value)];
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([body])
  });
  if (!r.ok) throw new Error(`KV SET failed: ${r.status}`);
  return true;
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

  if (!tokens || typeof tokens !== 'object') {
    return { email: null, step: 'tokens_not_object' };
  }

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
    const hasKvUrl = !!process.env.KV_REST_API_URL;
    const hasKvToken = !!process.env.KV_REST_API_TOKEN;
    // Test KV connectivity
    let kvOk = false, kvError = null;
    if (hasKvUrl && hasKvToken) {
      try { await kvGet('__ping__'); kvOk = true; }
      catch(e) { kvError = e.message; }
    }
    return res.status(200).json({
      authStep: step, authHint: hint || null, authed: !!email,
      kvEnvVarsSet: hasKvUrl && hasKvToken,
      kvConnected: kvOk, kvError,
      envVars: { KV_REST_API_URL: hasKvUrl, KV_REST_API_TOKEN: hasKvToken }
    });
  }

  const { email, step } = await getUserEmail(req);
  if (!email) {
    console.error(`[state] Auth failed: ${step}`);
    return res.status(401).json({ error: 'Not authenticated', step });
  }

  const key = `dashboard:${email.replace(/[^a-z0-9@._-]/gi, '_')}`;

  try {
    if (req.method === 'GET') {
      const state = await kvGet(key);
      return res.status(200).json({ state: state || null });
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
      await kvSet(key, body, STATE_TTL);
      return res.status(200).json({ ok: true, savedAt: body._savedAt });
    }

    if (req.method === 'DELETE') {
      const url = process.env.KV_REST_API_URL;
      const token = process.env.KV_REST_API_TOKEN;
      await fetch(`${url}/del/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[state] Error:', error.message);
    if (req.method === 'GET') return res.status(200).json({ state: null, kvError: error.message });
    return res.status(500).json({ error: 'State sync failed', detail: error.message });
  }
};