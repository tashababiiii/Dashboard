const { google } = require('googleapis');
const { parseCookies } = require('../_utils');

module.exports = async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) return res.redirect('/?auth=denied');
  if (!code) return res.status(400).send('No authorization code provided');

  // Validate CSRF state token
  const savedState = parseCookies(req)['oauth_state'];
  if (!savedState || savedState !== state) {
    return res.status(403).send('Invalid state parameter');
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await oauth2Client.getToken(code);
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
};