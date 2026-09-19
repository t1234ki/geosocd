export const config = { runtime: 'nodejs18.x' };

function verifySignature(rawBody, signature, secret) {
  const expected = `sha512=${require('node:crypto').createHmac('sha512', secret).update(rawBody).digest('hex')}`;
  if (!signature || expected.length !== signature.length) return false;
  try {
    return require('node:crypto').timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
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
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const signature = String(req.headers['x-paystack-signature'] || '');
  if (!secret || !verifySignature(rawBody, signature, secret)) {
    return res.status(401).json({ error: 'Invalid Paystack signature' });
  }

  const event = JSON.parse(rawBody.toString('utf8') || '{}');
  if ((event.event || '') !== 'charge.success') {
    return res.status(200).json({ received: true });
  }

  const data = event.data || {};
  const reference = String(data.reference || '').trim();
  const amount = Number((data.amount || 0) / 100);
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!supabaseUrl || !reference) {
    return res.status(422).json({ error: 'Invalid charge.success payload' });
  }

  const paymentLookup = await supabaseRequest(`/rest/v1/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=id,due_id,member_id,status,amount`);
  let paymentRecord = Array.isArray(paymentLookup.data) ? paymentLookup.data[0] : null;

  if (!paymentRecord) {
    const metadata = typeof data.metadata === 'string' ? JSON.parse(data.metadata || '{}') : (data.metadata || {});
    const dueId = metadata.due_id || '';
    const memberId = metadata.member_id || '';
    if (!dueId || !memberId) {
      return res.status(422).json({ error: 'Verified payment is missing due/member metadata' });
    }

    const dueLookup = await supabaseRequest(`/rest/v1/dues?id=eq.${encodeURIComponent(dueId)}&select=id,member_id,amount`);
    if (dueLookup.status >= 400 || !Array.isArray(dueLookup.data) || dueLookup.data.length !== 1 || (dueLookup.data[0].member_id !== null && dueLookup.data[0].member_id !== memberId)) {
      return res.status(422).json({ error: 'Verified payment does not match a valid due' });
    }

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
      return res.status(502).json({ error: 'Supabase could not record the verified payment', status: insertResult.status, detail: insertResult.data });
    }

    const createdLookup = await supabaseRequest(`/rest/v1/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=id,due_id,member_id,status,amount`);
    paymentRecord = Array.isArray(createdLookup.data) ? createdLookup.data[0] : null;
  }

  if (!paymentRecord) {
    return res.status(502).json({ error: 'Could not resolve payment record' });
  }

  await supabaseRequest(`/rest/v1/payments?id=eq.${encodeURIComponent(paymentRecord.id)}`, {
    method: 'PATCH',
    body: {
      status: 'paid',
      paid_at: new Date().toISOString(),
    },
  });

  const dueId = paymentRecord.due_id;
  const dueLookup = await supabaseRequest(`/rest/v1/dues?id=eq.${encodeURIComponent(dueId)}&select=amount`);
  const dueAmount = Number((Array.isArray(dueLookup.data) ? dueLookup.data[0]?.amount : 0) || 0);
  const paidLookup = await supabaseRequest(`/rest/v1/payments?due_id=eq.${encodeURIComponent(dueId)}&status=eq.paid&select=amount`);
  const paidTotal = Array.isArray(paidLookup.data) ? paidLookup.data.reduce((sum, row) => sum + Number(row.amount || 0), 0) : 0;

  await supabaseRequest(`/rest/v1/dues?id=eq.${encodeURIComponent(dueId)}`, {
    method: 'PATCH',
    body: {
      status: dueAmount > 0 && paidTotal >= dueAmount ? 'paid' : 'pending',
    },
  });

  const profileLookup = await supabaseRequest(`/rest/v1/profiles?id=eq.${encodeURIComponent(paymentRecord.member_id)}&select=phone,index_number`);
  const profile = Array.isArray(profileLookup.data) ? profileLookup.data[0] : null;
  const phone = profile?.phone || data.metadata?.member_phone || '';
  const receiptNumber = `GEO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await supabaseRequest('/rest/v1/receipts', {
    method: 'POST',
    body: {
      payment_id: paymentRecord.id,
      receipt_number: receiptNumber,
    },
  });

  if (phone && process.env.SMS_API_KEY) {
    await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phone,
        from: process.env.SMS_SENDER_ID || 'GEODues',
        sms: `GEODues payment received: GHS ${amount.toFixed(2)}. Receipt ${receiptNumber}. Ref: ${reference}`,
        type: 'plain',
        api_key: process.env.SMS_API_KEY,
        channel: 'generic',
      }),
    });
  }

  return res.status(200).json({ received: true, reference });
}
