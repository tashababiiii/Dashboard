/**
 * Shared utilities for Natasha Dashboard API functions.
 * Import with: const { parseCookies, ALLOWED_ORIGINS, setCorsHeaders, refreshTokenIfNeeded } = require('./_utils');
 */

const { google } = require('googleapis');

const ALLOWED_ORIGINS = [
  'https://natasha-daily-dashboard.vercel.app',
  'http://localhost:3000'
];

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

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function refreshTokenIfNeeded(tokens) {
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 300000) {
    const client = getOAuth2Client();
    client.setCredentials(tokens);
    const { credentials } = await client.refreshAccessToken();
    return credentials;
  }
  return tokens;
}

function parseBody(req) {
  return new Promise(async (resolve, reject) => {
    try {
      let body = req.body;
      if (!body) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      if (typeof body === 'string') body = JSON.parse(body);
      resolve(body);
    } catch(e) {
      reject(e);
    }
  });
}

module.exports = { parseCookies, ALLOWED_ORIGINS, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded, parseBody };