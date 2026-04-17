const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

module.exports = async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('No authorization code provided');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    const tokenData = JSON.stringify(tokens);
    const encoded = Buffer.from(tokenData).toString('base64');
    
    res.setHeader('Set-Cookie', [
      `gcal_tokens=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
    ]);
    
    res.redirect('/');
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
};
