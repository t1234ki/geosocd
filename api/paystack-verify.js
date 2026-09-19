export const config = { runtime: 'nodejs18.x' };

const jsonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret || !reference || !/^[A-Za-z0-9.=\-]+$/.test(reference)) {
    return res.status(422).json({ error: 'Invalid payment verification data' });
  }

  const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
  });

  const paystackText = await paystackResponse.text();
  let paystackJson = {};
  try {
    paystackJson = paystackText ? JSON.parse(paystackText) : {};
  } catch {
    return res.status(502).json({ error: 'Paystack returned an invalid response' });
  }
  const verified = paystackJson ?? {};
  const data = verified.data ?? {};

  if (!paystackResponse.ok || verified.status !== true || data.status !== 'success') {
    return res.status(422).json({ error: 'Paystack payment is not verified', payload: verified });
  }

  let metadata = data.metadata ?? {};
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata || '{}');
    } catch {
      return res.status(422).json({ error: 'Verified payment metadata is invalid' });
    }
  }
  const dueId = metadata.due_id || '';
  const memberId = metadata.member_id || '';
  const amount = Number((data.amount ?? 0) / 100);

  if (!dueId || !memberId || amount <= 0) {
    return res.status(422).json({ error: 'Verified payment is missing due/member metadata' });
  }

  const dueQuery = await supabaseRequest(`/rest/v1/dues?id=eq.${encodeURIComponent(dueId)}&select=id,member_id,amount`);
  if (dueQuery.status >= 400 || !Array.isArray(dueQuery.data) || dueQuery.data.length !== 1 || (dueQuery.data[0].member_id !== null && dueQuery.data[0].member_id !== memberId)) {
    return res.status(422).json({ error: 'Verified payment does not match a valid due', status: dueQuery.status, detail: dueQuery.data });
  }

  const ticketQuery = await supabaseRequest(`/rest/v1/tickets?due_id=eq.${encodeURIComponent(dueId)}&select=capacity`);
  if (ticketQuery.status < 400 && Array.isArray(ticketQuery.data) && ticketQuery.data.length === 1) {
    const duplicateQuery = await supabaseRequest(`/rest/v1/payments?due_id=eq.${encodeURIComponent(dueId)}&member_id=eq.${encodeURIComponent(memberId)}&status=eq.paid&select=id`);
    if (duplicateQuery.status < 400 && Array.isArray(duplicateQuery.data) && duplicateQuery.data.length > 0) {
      return res.status(409).json({ error: 'You have already purchased this ticket' });
    }
    const capacity = ticketQuery.data[0].capacity;
    if (capacity !== null && capacity !== undefined) {
      const soldQuery = await supabaseRequest(`/rest/v1/payments?due_id=eq.${encodeURIComponent(dueId)}&status=eq.paid&select=id`);
      if (soldQuery.status < 400 && Array.isArray(soldQuery.data) && soldQuery.data.length >= Number(capacity)) {
        return res.status(409).json({ error: 'This ticket is sold out' });
      }
    }
  }

  const existingQuery = await supabaseRequest(`/rest/v1/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=id`);
  if (existingQuery.status >= 400) {
    return res.status(502).json({ error: 'Could not query payments', status: existingQuery.status, detail: existingQuery.data });
  }

  if (Array.isArray(existingQuery.data) && existingQuery.data.length === 0) {
    const insertResult = await supabaseRequest('/rest/v1/payments', {
      method: 'POST',
      body: {
        due_id: dueId,
        member_id: memberId,
        amount,
        paystack_reference: reference,
        status: 'paid',
        paid_at: new Date().toISOString(),
      },
    });

    if (insertResult.status >= 400) {
      return res.status(502).json({ error: 'Could not record verified payment', status: insertResult.status, detail: insertResult.data });
    }
  }

  const confirmQuery = await supabaseRequest(`/rest/v1/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=id`);
  const paymentRecord = Array.isArray(confirmQuery.data) ? confirmQuery.data[0] : null;
  const paymentId = paymentRecord?.id;

  if (paymentId) {
    const receiptQuery = await supabaseRequest(`/rest/v1/receipts?payment_id=eq.${encodeURIComponent(paymentId)}&select=id`);
    if (receiptQuery.status < 400 && Array.isArray(receiptQuery.data) && receiptQuery.data.length === 0) {
      const receiptNumber = `GEO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      await supabaseRequest('/rest/v1/receipts', {
        method: 'POST',
        body: {
          payment_id: paymentId,
          receipt_number: receiptNumber,
        },
      });
    }
  }

  const paidQuery = await supabaseRequest(`/rest/v1/payments?due_id=eq.${encodeURIComponent(dueId)}&status=eq.paid&select=amount`);
  const paidRows = Array.isArray(paidQuery.data) ? paidQuery.data : [];
  const paidTotal = paidRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const dueAmount = Number(dueQuery.data[0].amount || 0);

  await supabaseRequest(`/rest/v1/dues?id=eq.${encodeURIComponent(dueId)}`, {
    method: 'PATCH',
    body: {
      status: paidTotal >= dueAmount ? 'paid' : 'pending',
    },
  });

  return res.status(200).json({ recorded: true, reference });
}
