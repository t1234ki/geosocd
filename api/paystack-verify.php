<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: POST, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST required']);
    exit;
}

if (is_file(__DIR__ . '/../.env')) {
    foreach (file(__DIR__ . '/../.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value, " \t\"'");
        if ($key !== '' && getenv($key) === false) {
            putenv($key . '=' . $value);
        }
    }
}

$secret = getenv('PAYSTACK_SECRET_KEY');
$supabaseUrl = rtrim(getenv('SUPABASE_URL'), '/');
$serviceKey = getenv('SUPABASE_SERVICE_ROLE_KEY');
$input = json_decode(file_get_contents('php://input'), true) ?: [];
$reference = $input['reference'] ?? '';
$caBundle = getenv('CURL_CA_BUNDLE') ?: 'C:\\Program Files\\Git\\usr\\ssl\\certs\\ca-bundle.crt';

if (!$secret || !$supabaseUrl || !$serviceKey || !is_string($reference) || !preg_match('/^[A-Za-z0-9.=\-]+$/', $reference)) {
    http_response_code(422);
    echo json_encode(['error' => 'Invalid payment verification data']);
    exit;
}

$paystack = curl_init('https://api.paystack.co/transaction/verify/' . rawurlencode($reference));
curl_setopt_array($paystack, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $secret], CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_CAINFO => $caBundle]);
$paystackResponse = curl_exec($paystack);
$paystackStatus = curl_getinfo($paystack, CURLINFO_HTTP_CODE);
curl_close($paystack);
$verified = json_decode($paystackResponse ?: '{}', true) ?: [];
$data = $verified['data'] ?? [];
if ($paystackStatus < 200 || $paystackStatus >= 300 || ($verified['status'] ?? false) !== true || ($data['status'] ?? '') !== 'success') {
    http_response_code(422);
    echo json_encode(['error' => 'Paystack payment is not verified']);
    exit;
}

$metadata = $data['metadata'] ?? [];
if (is_string($metadata)) {
    $metadata = json_decode($metadata, true) ?: [];
}
$dueId = $metadata['due_id'] ?? '';
$memberId = $metadata['member_id'] ?? '';
$amount = ($data['amount'] ?? 0) / 100;
if (!$dueId || !$memberId || $amount <= 0) {
    http_response_code(422);
    echo json_encode(['error' => 'Verified payment is missing due/member metadata']);
    exit;
}

$headers = ['Content-Type: application/json', 'apikey: ' . $serviceKey, 'Authorization: Bearer ' . $serviceKey, 'Prefer: return=minimal'];
$request = function (string $method, string $path, ?array $body = null) use ($supabaseUrl, $headers, $caBundle): array {
    $ch = curl_init($supabaseUrl . $path);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_POSTFIELDS => $body ? json_encode($body) : null, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_CAINFO => $caBundle]);
    $response = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, json_decode($response ?: '[]', true) ?: []];
};

[$dueStatus, $dues] = $request('GET', '/rest/v1/dues?id=eq.' . rawurlencode($dueId) . '&select=id,member_id,amount');
if ($dueStatus >= 400 || count($dues) !== 1 || ($dues[0]['member_id'] !== null && $dues[0]['member_id'] !== $memberId)) {
    http_response_code(422);
    echo json_encode(['error' => 'Verified payment does not match a valid due', 'status' => $dueStatus, 'detail' => $dues]);
    exit;
}

[$ticketStatus, $ticketRows] = $request('GET', '/rest/v1/tickets?due_id=eq.' . rawurlencode($dueId) . '&select=capacity');
if ($ticketStatus < 400 && count($ticketRows) === 1) {
    [$duplicateStatus, $duplicateRows] = $request('GET', '/rest/v1/payments?due_id=eq.' . rawurlencode($dueId) . '&member_id=eq.' . rawurlencode($memberId) . '&status=eq.paid&select=id');
    if ($duplicateStatus < 400 && count($duplicateRows) > 0) {
        http_response_code(409);
        echo json_encode(['error' => 'You have already purchased this ticket']);
        exit;
    }
    $capacity = $ticketRows[0]['capacity'] ?? null;
    if ($capacity !== null) {
        [$soldStatus, $soldRows] = $request('GET', '/rest/v1/payments?due_id=eq.' . rawurlencode($dueId) . '&status=eq.paid&select=id');
        if ($soldStatus < 400 && count($soldRows) >= (int) $capacity) {
            http_response_code(409);
            echo json_encode(['error' => 'This ticket is sold out']);
            exit;
        }
    }
}

[$existingStatus, $existing] = $request('GET', '/rest/v1/payments?paystack_reference=eq.' . rawurlencode($reference) . '&select=id');
if ($existingStatus >= 400) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not query payments', 'status' => $existingStatus, 'detail' => $existing]);
    exit;
}
if (count($existing) === 0) {
    [$insertStatus, $insertResponse] = $request('POST', '/rest/v1/payments', ['due_id' => $dueId, 'member_id' => $memberId, 'amount' => $amount, 'paystack_reference' => $reference, 'status' => 'paid', 'paid_at' => gmdate('c')]);
    if ($insertStatus >= 400) {
        http_response_code(502);
        echo json_encode(['error' => 'Could not record verified payment', 'status' => $insertStatus, 'detail' => $insertResponse]);
        exit;
    }
}
$existing = $request('GET', '/rest/v1/payments?paystack_reference=eq.' . rawurlencode($reference) . '&select=id');
$paymentId = $existing[1][0]['id'] ?? '';
if ($paymentId) {
    [$receiptStatus, $receipts] = $request('GET', '/rest/v1/receipts?payment_id=eq.' . rawurlencode($paymentId) . '&select=id');
    if ($receiptStatus < 400 && count($receipts) === 0) {
        $receiptNumber = 'GEO-' . date('Ymd') . '-' . strtoupper(substr(hash('sha256', $reference), 0, 8));
        $request('POST', '/rest/v1/receipts', ['payment_id' => $paymentId, 'receipt_number' => $receiptNumber]);
    }
}
[$paidStatus, $paidRows] = $request('GET', '/rest/v1/payments?due_id=eq.' . rawurlencode($dueId) . '&status=eq.paid&select=amount');
$paidTotal = array_sum(array_map(static fn (array $row): int => (int) ($row['amount'] ?? 0), $paidRows));
$request('PATCH', '/rest/v1/dues?id=eq.' . rawurlencode($dueId), ['status' => $paidTotal >= (int) ($dues[0]['amount'] ?? 0) ? 'paid' : 'pending']);
echo json_encode(['recorded' => true, 'reference' => $reference]);
