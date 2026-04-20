/**
 * /api/auth
 * Unified auth endpoint — handles login, callback, logout, and session check.
 * Routes by ?action= query param:
 *   ?action=login    → initiates Google OAuth flow
 *   ?action=callback → handles OAuth callback (also accepts ?code= directly)
 *   ?action=logout   → clears session cookie
 *   ?action=check    → verifies session and email allowlist
 */

const { google } = require('googleapis');
const crypto = require('crypto');
const { parseCookies, setCorsHeaders, getOAuth2Client } = require('./_utils');

const ALLOWED_EMAILS = ['nbradley@645ventures.com', 'natashapbradley@gmail.com'];

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/userinfo.email'
];

// ── LOGIN ─────────────────────────────────────────────────────────────────────
function handleLogin(req, res) {
  const oauth2Client = getOAuth2Client();
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie',
    `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  res.redirect(oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  }));
}

// ── CALLBACK ──────────────────────────────────────────────────────────────────
async function handleCallback(req, res) {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) return res.redirect('/?auth=denied');
  if (!code) return res.status(400).send('No authorization code provided');

  // Validate CSRF state token
  const savedState = parseCookies(req)['oauth_state'];
  if (!savedState || savedState !== state) {
    return res.status(403).send('Invalid state parameter');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    // Email allowlist check — only Natasha can log in
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = userInfo.email?.toLowerCase();

    if (!ALLOWED_EMAILS.includes(email)) {
      return res.status(403).send(`
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:monospace;background:#FAF8F5;">
          <div style="text-align:center;padding:40px;">
            <div style="font-size:48px;margin-bottom:16px;">🔒</div>
            <div style="font-size:20px;color:#2C1654;margin-bottom:8px;">Access Denied</div>
            <div style="font-size:13px;color:#8888A4;">This dashboard is private.</div>
          </div>
        </div>`);
    }

    const encoded = Buffer.from(JSON.stringify(tokens)).toString('base64');
    res.setHeader('Set-Cookie', [
      `gcal_tokens=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      `oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure`
    ]);
    res.redirect('/');
  } catch (error) {
    console.error('Auth callback error:', error.message);
    res.status(500).send('Authentication failed. Please try again.');
  }
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────
function handleLogout(req, res) {
  res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
  res.setHeader('Cache-Control', 'no-store');
  res.redirect('/');
}

// ── CHECK ─────────────────────────────────────────────────────────────────────
async function handleCheck(req, res) {
  setCorsHeaders(req, res);
  try {
    const cookies = parseCookies(req);
    const tokenCookie = cookies['gcal_tokens'];
    if (!tokenCookie) return res.status(200).json({ authed: false });

    const tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = userInfo.email?.toLowerCase();

    if (!ALLOWED_EMAILS.includes(email)) {
      res.setHeader('Set-Cookie', `gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure`);
      return res.status(200).json({ authed: false });
    }

    return res.status(200).json({ authed: true, email });
  } catch (e) {
    return res.status(200).json({ authed: false });
  }
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Support both ?action= and legacy path-based routing
  // /api/auth?action=login | /api/auth?action=callback | etc.
  const action = req.query.action;

  // Also detect callback by presence of ?code= (Google redirects here)
  if (action === 'login') return handleLogin(req, res);
  if (action === 'callback' || req.query.code) return handleCallback(req, res);
  if (action === 'logout') return handleLogout(req, res);
  if (action === 'check') return handleCheck(req, res);

  return res.status(400).json({ error: 'Missing action param. Use ?action=login|callback|logout|check' });
};