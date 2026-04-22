// /api/state.js — Server-side state sync for cross-device support
// Uses Vercel KV (Redis) to store dashboard state per authenticated user
// GET  /api/state       → returns saved state JSON
// POST /api/state       → saves state JSON, returns { ok: true, savedAt }
// DELETE /api/state     → clears saved state

const { parseCookies, setCorsHeaders } = require('./_utils');

// Vercel KV is accessed via @vercel/kv package
// State is keyed per user email so each user has isolated state
const STATE_TTL = 60 * 60 * 24 * 90; // 90 days in seconds

async function getKV() {
  // Lazy import Vercel KV
  const { kv } = await import('@vercel/kv');
  return kv;
}

function getUserKey(email) {
  // Sanitize email for use as a Redis key
  return `dashboard:state:${email.replace(/[^a-z0-9@._-]/gi, '_')}`;
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cookies = parseCookies(req);
  const tokenCookie = cookies['gcal_tokens'];
  if (!tokenCookie) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  let userEmail;
  try {
    const tokens = JSON.parse(decodeURIComponent(tokenCookie));
    userEmail = tokens.email;
    if (!userEmail) throw new Error('No email in token');
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const key = getUserKey(userEmail);

  try {
    const kv = await getKV();

    if (req.method === 'GET') {
      // Return saved state
      const state = await kv.get(key);
      if (!state) return res.status(200).json({ state: null });
      return res.status(200).json({ state, savedAt: state._savedAt || null });
    }

    if (req.method === 'POST') {
      // Save state
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {
          return res.status(400).json({ error: 'Invalid JSON body' });
        }
      }
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }

      // Size guard — state shouldn't exceed 512KB
      const stateStr = JSON.stringify(body);
      if (stateStr.length > 512 * 1024) {
        return res.status(413).json({ error: 'State too large (max 512KB)' });
      }

      body._savedAt = Date.now();
      body._savedBy = 'server';
      await kv.set(key, body, { ex: STATE_TTL });

      return res.status(200).json({ ok: true, savedAt: body._savedAt });
    }

    if (req.method === 'DELETE') {
      await kv.del(key);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[state] Error:', error.message);
    // Don't fail hard — dashboard should work even if KV is down
    if (req.method === 'GET') return res.status(200).json({ state: null, error: 'KV unavailable' });
    return res.status(500).json({ error: 'State sync unavailable', message: error.message });
  }
};