export const config = { runtime: 'nodejs18.x' };

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const input = await readJsonBody(req);
  const email = String(input.email || '').trim();
  const amount = Number(input.amount);
  const reference = String(input.reference || '').trim();
  const metadata = input.metadata ?? {};
  const callbackUrl = input.callback_url ? String(input.callback_url).trim() : '';
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret || !/^\S+@\S+\.\S+$/.test(email) || !Number.isInteger(amount) || amount < 1 || !/^[A-Za-z0-9.=\-]+$/.test(reference) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || (callbackUrl && !/^https?:\/\//i.test(callbackUrl))) {
    return res.status(422).json({ error: 'Invalid payment initialization data' });
  }

  let paystackResponse;
  try {
    paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount,
        currency: 'GHS',
        reference,
        metadata,
        callback_url: callbackUrl || undefined,
      }),
    });
  } catch (error) {
    return res.status(502).json({ error: 'Paystack connection failed', detail: error instanceof Error ? error.message : 'Unknown connection error' });
  }

  const rawText = await paystackResponse.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    return res.status(502).json({ error: 'Paystack returned an invalid response' });
  }

  if (!paystackResponse.ok || payload.status !== true || !payload.data?.authorization_url) {
    return res.status(502).json({ error: payload.message || 'Paystack transaction initialization failed' });
  }

  return res.status(200).json({ authorization_url: payload.data.authorization_url, reference });
}
