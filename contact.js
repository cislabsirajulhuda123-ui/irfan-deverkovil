const recentSubmissions = new Map();
const RATE_LIMIT_MS = 30_000;
const DEFAULT_RECIPIENT = '8590133631';

function respond(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function getRequestBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;

  try {
    return new URL(origin).host === host.split(',')[0].trim();
  } catch {
    return false;
  }
}

module.exports = async function contact(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { error: 'Method not allowed.' });
  }

  if (!isSameOriginRequest(req)) {
    return respond(res, 403, { error: 'This request is not allowed.' });
  }

  if (!req.headers['content-type']?.toLowerCase().includes('application/json')) {
    return respond(res, 415, { error: 'Send the form as JSON.' });
  }

  const body = getRequestBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return respond(res, 400, { error: 'The submitted form is invalid.' });
  }

  if (typeof body.company === 'string' && body.company.trim()) {
    return respond(res, 400, { error: 'The submitted form is invalid.' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (
    !name ||
    name.length > 100 ||
    /[\r\n]/.test(name) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !message ||
    message.length > 1000
  ) {
    return respond(res, 400, { error: 'Enter a valid name, email address, and message.' });
  }

  const clientIp = typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : '';
  const now = Date.now();
  if (clientIp) {
    for (const [ip, submittedAt] of recentSubmissions) {
      if (now - submittedAt >= RATE_LIMIT_MS) recentSubmissions.delete(ip);
    }
    if (recentSubmissions.has(clientIp)) {
      return respond(res, 429, { error: 'Please wait a moment before sending another message.' });
    }
    recentSubmissions.set(clientIp, now);
  }

  const apiKey = process.env.FAST2SMS_API_KEY;
  const recipient = process.env.CONTACT_PHONE || DEFAULT_RECIPIENT;
  if (!apiKey || !/^\d{10}$/.test(recipient)) {
    return respond(res, 503, { error: 'Contact messaging is not configured. Please try again later.' });
  }

  const smsMessage = `New portfolio message\nName: ${name}\nEmail: ${email}\nMessage: ${message}`;
  const smsBody = new URLSearchParams({
    route: 'q',
    language: 'english',
    flash: '0',
    numbers: recipient,
    message: smsMessage
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const providerResponse = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: smsBody,
      signal: controller.signal
    });

    let providerResult;
    try {
      providerResult = await providerResponse.json();
    } catch {
      console.error('Fast2SMS returned an unreadable response.');
      return respond(res, 502, { error: 'Unable to send your message right now. Please try again later.' });
    }

    if (!providerResponse.ok || !providerResult || providerResult.return !== true) {
      console.error(`Fast2SMS rejected a contact notification (HTTP ${providerResponse.status}).`);
      return respond(res, 502, { error: 'Unable to send your message right now. Please try again later.' });
    }

    return respond(res, 200, { message: 'Thanks for reaching out. Your message has been sent.' });
  } catch (error) {
    console.error(error.name === 'AbortError'
      ? 'Fast2SMS contact notification timed out.'
      : 'Fast2SMS contact notification request failed.');
    return respond(res, 502, { error: 'Unable to send your message right now. Please try again later.' });
  } finally {
    clearTimeout(timeout);
  }
};
