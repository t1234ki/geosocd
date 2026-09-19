<?php
// Deploy this endpoint on a server. Keep all secrets in environment variables.
header('Content-Type: application/json');
$payload = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_PAYSTACK_SIGNATURE'] ?? '';
$secret = getenv('PAYSTACK_SECRET_KEY');

if (!$secret || !hash_equals(hash_hmac('sha512', $payload, $secret), $signature)) {
    http_response_code(401);
    echo json_encode(['error' => 'Invalid Paystack signature']);
    exit;
}

$event = json_decode($payload, true);
if (($event['event'] ?? '') !== 'charge.success') {
    echo json_encode(['received' => true]);
    exit;
}

$data = $event['data'] ?? [];
$reference = $data['reference'] ?? '';
$amount = ($data['amount'] ?? 0) / 100;

// Use the service role key only on the server to update the payment record.
$supabaseUrl = rtrim(getenv('SUPABASE_URL'), '/');
$serviceKey = getenv('SUPABASE_SERVICE_ROLE_KEY');
$headers = ['Content-Type: application/json', 'apikey: ' . $serviceKey, 'Authorization: Bearer ' . $serviceKey, 'Prefer: return=minimal'];
$caBundle = getenv('CURL_CA_BUNDLE') ?: 'C:\\Program Files\\Git\\usr\\ssl\\certs\\ca-bundle.crt';
$request = function (string $method, string $path, ?array $body = null) use ($supabaseUrl, $headers, $caBundle): array {
    $ch = curl_init($supabaseUrl . $path);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_POSTFIELDS => $body ? json_encode($body) : null, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_CAINFO => $caBundle]);
    $response = curl_exec($ch);
    $curlError = curl_error($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, json_decode($response ?: json_encode(['curl_error' => $curlError]), true) ?: []];
};

[$paymentStatus, $payments] = $request('GET', '/rest/v1/payments?paystack_reference=eq.' . rawurlencode($reference) . '&select=id,due_id,member_id,status,amount');
if ($paymentStatus >= 400) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not query payment records']);
    exit;
}

if (count($payments) === 1) {
    $payment = $payments[0];
} else {
    $metadata = $data['metadata'] ?? [];
    $dueId = $metadata['due_id'] ?? '';
    $memberId = $metadata['member_id'] ?? '';
    if (!$dueId || !$memberId) {
        http_response_code(422);
        echo json_encode(['error' => 'Verified payment is missing due/member metadata']);
        exit;
    }

    [$dueStatus, $dues] = $request('GET', '/rest/v1/dues?id=eq.' . rawurlencode($dueId) . '&select=id,member_id,amount');
    if ($dueStatus >= 400) {
        http_response_code(502);
        echo json_encode(['error' => 'Supabase could not read the due', 'status' => $dueStatus]);
        exit;
    }
    if (count($dues) !== 1 || ($dues[0]['member_id'] !== null && $dues[0]['member_id'] !== $memberId)) {
        http_response_code(422);
        echo json_encode(['error' => 'Verified payment does not match a valid due', 'due_rows' => count($dues)]);
        exit;
    }

    [$insertStatus, $insertResponse] = $request('POST', '/rest/v1/payments', ['due_id' => $dueId, 'member_id' => $memberId, 'amount' => $amount, 'paystack_reference' => $reference, 'status' => 'paid', 'paid_at' => gmdate('c')]);
    if ($insertStatus >= 400) {
        http_response_code(502);
        echo json_encode(['error' => 'Supabase could not record the verified payment', 'status' => $insertStatus]);
        exit;
    }
    [$createdStatus, $createdPayments] = $request('GET', '/rest/v1/payments?paystack_reference=eq.' . rawurlencode($reference) . '&select=id,due_id,member_id,status,amount');
    if ($createdStatus >= 400 || count($createdPayments) !== 1) {
        http_response_code(502);
        echo json_encode(['error' => 'Could not save verified payment']);
        exit;
    }
    $payment = $createdPayments[0];
}

$request('PATCH', '/rest/v1/payments?id=eq.' . rawurlencode($payment['id']), ['status' => 'paid', 'paid_at' => gmdate('c')]);
[$totalStatus, $paidPayments] = $request('GET', '/rest/v1/payments?due_id=eq.' . rawurlencode($payment['due_id']) . '&status=eq.paid&select=amount');
$dueAmount = 0;
if (isset($dues[0]['amount'])) $dueAmount = (int) $dues[0]['amount'];
if (!$dueAmount) {
    [$currentDueStatus, $currentDue] = $request('GET', '/rest/v1/dues?id=eq.' . rawurlencode($payment['due_id']) . '&select=amount');
    $dueAmount = (int) ($currentDue[0]['amount'] ?? 0);
}
$paidTotal = array_sum(array_map(static fn (array $row): int => (int) ($row['amount'] ?? 0), $paidPayments));
$request('PATCH', '/rest/v1/dues?id=eq.' . rawurlencode($payment['due_id']), ['status' => $dueAmount > 0 && $paidTotal >= $dueAmount ? 'paid' : 'pending']);

[$profileStatus, $profiles] = $request('GET', '/rest/v1/profiles?id=eq.' . rawurlencode($payment['member_id']) . '&select=phone,index_number');
$phone = $profiles[0]['phone'] ?? ($data['metadata']['member_phone'] ?? '');
$receiptNumber = 'GEO-' . date('Ymd') . '-' . strtoupper(substr(hash('sha256', $reference), 0, 8));
$request('POST', '/rest/v1/receipts', ['payment_id' => $payment['id'], 'receipt_number' => $receiptNumber]);
$message = 'GEODues payment received: GHS ' . number_format($amount, 2) . '. Receipt ' . $receiptNumber . '. Ref: ' . $reference;
$notification = ['member_id' => $payment['member_id'], 'payment_id' => $payment['id'], 'channel' => 'sms', 'status' => 'pending', 'recipient' => $phone, 'message' => $message];

// Termii example. Swap this block for Twilio if SMS_PROVIDER=twilio.
if ($phone && getenv('SMS_API_KEY')) {
    $sms = ['to' => $phone, 'from' => getenv('SMS_SENDER_ID') ?: 'GEODues', 'sms' => $message, 'type' => 'plain', 'api_key' => getenv('SMS_API_KEY'), 'channel' => 'generic'];
    $smsCh = curl_init('https://api.ng.termii.com/api/sms/send');
    curl_setopt_array($smsCh, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($sms), CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_RETURNTRANSFER => true]);
    $smsResponse = curl_exec($smsCh);
    $smsStatus = curl_getinfo($smsCh, CURLINFO_HTTP_CODE);
    curl_close($smsCh);
    $notification['status'] = $smsStatus >= 200 && $smsStatus < 300 ? 'sent' : 'failed';
    $notification['sent_at'] = $notification['status'] === 'sent' ? gmdate('c') : null;
} else {
    $notification['status'] = 'failed';
}

$request('POST', '/rest/v1/notifications', $notification);

echo json_encode(['received' => true, 'reference' => $reference]);
