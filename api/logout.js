module.exports = (req, res) => {
  res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
  res.setHeader('Cache-Control', 'no-store');
  res.redirect('/');
};