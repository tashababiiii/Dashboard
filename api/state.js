// /api/state.js — Cross-device state sync via Vercel KV (Redis)
// GET  /api/state        → returns saved state
// POST /api/state        → saves state
// GET  /api/state?debug  → returns diagnostic info (no sensitive data)

const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');
const { google } = require('googleapis');

const STATE_TTL = 60 * 60 * 24 * 90; // 90 days
const ALLOWED_EMAILS = ['nbradley@645ventures.com', 'natashapbradley@gmail.com'];

async function getKV() {
  try {
    const { kv } = await import('@vercel/kv');
    return { kv, error: null };
  } catch(e) {
    return { kv: null, error: e.message };
  }
}

async function getUserEmail(req) {
  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) return { email: null, step: 'no_cookie' };

  let tokens;

  // Step 1: Try Base64 decode (how auth.js stores it)
  try {
    const decoded = Buffer.from(tokenCookie, 'base64').toString('utf8');
    tokens = JSON.parse(decoded);
  } catch(e) {
    // Step 2: Try raw JSON fallback
    try {
      tokens = JSON.parse(tokenCookie);
    } catch(e2) {
      return { email: null, step: 'cookie_parse_failed', hint: e2.message };
    }
  }

  if (!tokens || typeof tokens !== 'object') {
    return { email: null, step: 'tokens_not_object' };
  }

  // Step 3: Check if email is already in the token (set by updated auth.js)
  if (tokens.email) {
    const email = tokens.email.toLowerCase();
    if (ALLOWED_EMAILS.includes(email)) return { email, step: 'from_token' };
    return { email: null, step: 'email_not_allowed', hint: email };
  }

  // Step 4: No email in token — fetch from Google userinfo
  // (happens for sessions set before auth.js was updated)
  if (!tokens.access_token) {
    return { email: null, step: 'no_access_token' };
  }

  try {
    const client = getOAuth2Client();
    const refreshed = await refreshTokenIfNeeded(tokens);
    client.setCredentials(refreshed);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    const email = data.email?.toLowerCase();
    if (!email) return { email: null, step: 'userinfo_no_email' };
    if (!ALLOWED_EMAILS.includes(email)) return { email: null, step: 'email_not_allowed', hint: email };
    return { email, step: 'from_google_userinfo' };
  } catch(e) {
    return { email: null, step: 'userinfo_failed', hint: e.message };
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Debug endpoint — safe, no sensitive data exposed
  if (req.method === 'GET' && req.query?.debug !== undefined) {
    const { email, step, hint } = await getUserEmail(req);
    const { kv, error: kvError } = await getKV();
    return res.status(200).json({
      authStep: step,
      authHint: hint || null,
      authed: !!email,
      kvAvailable: !!kv,
      kvError: kvError || null,
      envVars: {
        KV_REST_API_URL: !!process.env.KV_REST_API_URL,
        KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
        KV_URL: !!process.env.KV_URL,
      }
    });
  }

  const { email, step } = await getUserEmail(req);
  if (!email) {
    console.error(`[state] Auth failed at step: ${step}`);
    return res.status(401).json({ error: 'Not authenticated', step });
  }

  const key = `dashboard:state:${email.replace(/[^a-z0-9@._-]/gi, '_')}`;

  const { kv, error: kvError } = await getKV();
  if (!kv) {
    console.error('[state] KV unavailable:', kvError);
    // Don't fail hard — return empty state so dashboard still works
    if (req.method === 'GET') return res.status(200).json({ state: null, kvError });
    return res.status(500).json({ error: 'KV unavailable', detail: kvError });
  }

  try {
    if (req.method === 'GET') {
      const state = await kv.get(key);
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
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }

      const stateStr = JSON.stringify(body);
      if (stateStr.length > 512 * 1024) {
        return res.status(413).json({ error: 'State too large — max 512KB' });
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
    console.error('[state] KV operation failed:', error.message);
    if (req.method === 'GET') return res.status(200).json({ state: null, kvError: error.message });
    return res.status(500).json({ error: 'State sync failed', detail: error.message });
  }
};