/**
 * /api/parse-doc
 * Server-side document parser for the dashboard file upload feature.
 * Handles:
 *   - PDF  → pdf-parse (text extraction, no vision needed)
 *   - DOCX → mammoth  (Word documents)
 *   - XLSX → xlsx     (spreadsheets — extracts cell text)
 *   - Google Docs/Sheets/Drive links → fetches via Google Drive API using user's token
 *   - Plain text / CSV / MD → returned as-is (client handles these without this endpoint)
 */

const { parseCookies, setCorsHeaders, getOAuth2Client, refreshTokenIfNeeded } = require('./_utils');
const { google } = require('googleapis');

// Lazy-load heavy parsers so cold starts are fast when not needed
async function parsePDF(buffer) {
  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer);
  return result.text || '';
}

async function parseDOCX(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

async function parseXLSX(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const lines = [];
  wb.SheetNames.forEach(name => {
    const ws = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    if (csv.trim()) lines.push(`=== ${name} ===\n${csv}`);
  });
  return lines.join('\n\n');
}

// Extract a Google Drive file ID from any Google URL format
function extractDriveFileId(url) {
  // Patterns:
  // docs.google.com/document/d/FILE_ID/...
  // docs.google.com/spreadsheets/d/FILE_ID/...
  // docs.google.com/presentation/d/FILE_ID/...
  // drive.google.com/file/d/FILE_ID/...
  // drive.google.com/open?id=FILE_ID
  const patterns = [
    /\/d\/([a-zA-Z0-9_-]{25,})/,
    /[?&]id=([a-zA-Z0-9_-]{25,})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function getGoogleDocType(url) {
  if (url.includes('/spreadsheets/')) return 'sheet';
  if (url.includes('/presentation/')) return 'slides';
  if (url.includes('/document/')) return 'doc';
  return 'file';
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tokenCookie = parseCookies(req)['gcal_tokens'];
  if (!tokenCookie) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  try {
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (typeof body === 'string') body = JSON.parse(body);

    const { type, data, url, filename } = body || {};

    // ── GOOGLE LINK ───────────────────────────────────────────────────────
    if (type === 'google_link') {
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Missing URL' });
      }

      const fileId = extractDriveFileId(url);
      if (!fileId) {
        return res.status(400).json({ error: 'Could not extract file ID from URL. Make sure it is a valid Google Docs, Sheets, or Drive link.' });
      }

      let tokens = JSON.parse(Buffer.from(tokenCookie, 'base64').toString('utf8'));
      try { tokens = await refreshTokenIfNeeded(tokens); } catch(e) {
        res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
        return res.status(401).json({ error: 'Token expired', needsAuth: true });
      }

      const oauth2Client = getOAuth2Client();
      oauth2Client.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: oauth2Client });

      // Get file metadata to determine type
      const meta = await drive.files.get({
        fileId,
        fields: 'id,name,mimeType'
      });

      const mimeType = meta.data.mimeType;
      const name = meta.data.name || 'document';
      let text = '';

      if (mimeType === 'application/vnd.google-apps.document') {
        const exported = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
        text = exported.data || '';
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        const exported = await drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' });
        text = exported.data || '';
      } else if (mimeType === 'application/vnd.google-apps.presentation') {
        const exported = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
        text = exported.data || '';
      } else {
        // Binary file — download and parse
        const downloaded = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(downloaded.data);
        if (mimeType === 'application/pdf') {
          text = await parsePDF(buffer);
        } else if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') {
          text = await parseDOCX(buffer);
        } else if (mimeType.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel') {
          text = await parseXLSX(buffer);
        } else {
          text = buffer.toString('utf8');
        }
      }

      return res.status(200).json({ text: text.slice(0, 20000), filename: name, source: 'google_drive' });
    }

    // ── FILE UPLOAD (base64) ──────────────────────────────────────────────
    if (type === 'file') {
      if (!data || !filename) {
        return res.status(400).json({ error: 'Missing file data or filename' });
      }

      const buffer = Buffer.from(data, 'base64');
      const name = filename.toLowerCase();
      let text = '';

      if (name.endsWith('.pdf')) {
        text = await parsePDF(buffer);
      } else if (name.endsWith('.docx')) {
        text = await parseDOCX(buffer);
      } else if (name.endsWith('.doc')) {
        // Older .doc format — try mammoth, it handles some .doc files
        try { text = await parseDOCX(buffer); } catch(e) { text = buffer.toString('utf8'); }
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        text = await parseXLSX(buffer);
      } else {
        // Fallback: treat as UTF-8 text
        text = buffer.toString('utf8');
      }

      return res.status(200).json({ text: text.slice(0, 20000), filename, source: 'file_upload' });
    }

    return res.status(400).json({ error: 'Invalid request type. Use "file" or "google_link".' });

  } catch (error) {
    console.error('parse-doc error:', error.message);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      res.setHeader('Set-Cookie', 'gcal_tokens=; Path=/; Max-Age=0; HttpOnly; Secure');
      return res.status(401).json({ error: 'Token expired', needsAuth: true });
    }
    if (error.code === 403) {
      return res.status(403).json({ error: 'Google Drive access denied. Try signing out and back in — Drive access may need to be re-authorized.' });
    }
    return res.status(500).json({ error: 'Could not parse document' });
  }
};