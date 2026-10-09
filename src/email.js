const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function isEmailConfigured() {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !process.env.PUBLIC_BASE_URL) return false;
  try {
    const url = new URL(process.env.PUBLIC_BASE_URL);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}

async function sendEmail({ to, subject, html, text }) {
  if (!isEmailConfigured()) throw new Error('Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, text }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Email provider returned ${response.status}: ${details.slice(0, 300)}`);
  }
}

module.exports = { isEmailConfigured, sendEmail };
