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

async function supabaseRequest(path, { method = 'GET', body } = {}) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let payload = [];
  try {
    payload = rawText ? JSON.parse(rawText) : [];
  } catch {
    payload = rawText ? [{ raw: rawText }] : [];
  }

  return { status: response.status, data: payload };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST required' });
  }

  const input = await readJsonBody(req);
  const reference = String(input.reference || '').trim();
  const reason = String(input.reason || 'Admin refund').trim() || 'Admin refund';
  const amount = Number(input.amount || 0);
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret || !reference) {
    return res.status(422).json({ error: 'Invalid refund request' });
  }

  const paymentQuery = await supabaseRequest(`/rest/v1/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=id,amount,status,paystack_reference,member_id`);
  if (paymentQuery.status >= 400 || !Array.isArray(paymentQuery.data) || paymentQuery.data.length !== 1) {
    return res.status(404).json({ error: 'Payment not found for refund' });
  }

  const payment = paymentQuery.data[0];
  if (payment.status !== 'paid') {
    return res.status(409).json({ error: 'Only paid payments can be refunded' });
  }

  const refundAmount = Number.isFinite(amount) && amount > 0 ? Math.max(1, Math.round(amount * 100)) : Math.max(1, Math.round(Number(payment.amount || 0) * 100));

  const paystackResponse = await fetch('https://api.paystack.co/refund', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      transaction: reference,
      amount: refundAmount,
      reason,
    }),
  });

  const paystackJson = await paystackResponse.json();
  if (!paystackResponse.ok || paystackJson.status !== true) {
    return res.status(422).json({ error: paystackJson.message || 'Paystack refund request failed', payload: paystackJson });
  }

  const updateResult = await supabaseRequest(`/rest/v1/payments?id=eq.${encodeURIComponent(payment.id)}`, {
    method: 'PATCH',
    body: {
      refund_status: 'refunded',
      refund_reason: reason,
      refunded_at: new Date().toISOString(),
      status: 'paid',
    },
  });

  if (updateResult.status >= 400) {
    return res.status(502).json({ error: 'Refund was processed in Paystack but the local record could not be updated', status: updateResult.status, detail: updateResult.data });
  }

  return res.status(200).json({
    success: true,
    reference,
    amount: refundAmount / 100,
    reason,
    paystack_response: paystackJson,
  });
}
