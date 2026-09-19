<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
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
$reference = trim((string) ($input['reference'] ?? ''));
$reason = trim((string) ($input['reason'] ?? '')) ?: 'Admin refund';
$amount = (float) ($input['amount'] ?? 0);
$caBundle = getenv('CURL_CA_BUNDLE') ?: 'C:\\Program Files\\Git\\usr\\ssl\\certs\\ca-bundle.crt';

if (!$secret || !$supabaseUrl || !$serviceKey || $reference === '') {
    http_response_code(422);
    echo json_encode(['error' => 'Invalid refund request']);
    exit;
}

$headers = ['Content-Type: application/json', 'apikey: ' . $serviceKey, 'Authorization: Bearer ' . $serviceKey, 'Prefer: return=minimal'];
$request = function (string $method, string $path, ?array $body = null) use ($supabaseUrl, $headers, $caBundle): array {
    $ch = curl_init($supabaseUrl . $path);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_POSTFIELDS => $body ? json_encode($body) : null,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_CAINFO => $caBundle,
    ]);
    $response = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, json_decode($response ?: '[]', true) ?: []];
};

[$paymentStatus, $payments] = $request('GET', '/rest/v1/payments?paystack_reference=eq.' . rawurlencode($reference) . '&select=id,amount,status,paystack_reference,member_id');
if ($paymentStatus >= 400) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not load payment for refund', 'status' => $paymentStatus, 'detail' => $payments]);
    exit;
}

if (count($payments) !== 1) {
    http_response_code(404);
    echo json_encode(['error' => 'Payment not found for refund']);
    exit;
}

$payment = $payments[0];
if (($payment['status'] ?? '') !== 'paid') {
    http_response_code(409);
    echo json_encode(['error' => 'Only paid payments can be refunded']);
    exit;
}

$paystackAmount = max(1, (int) round($amount * 100));
if ($paystackAmount <= 0) {
    $paystackAmount = max(1, (int) round(((float) ($payment['amount'] ?? 0)) * 100));
}

$refundBody = [
    'transaction' => $reference,
    'amount' => $paystackAmount,
    'reason' => $reason,
];

$paystack = curl_init('https://api.paystack.co/refund');
curl_setopt_array($paystack, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($refundBody),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . $secret,
        'Content-Type: application/json',
        'Accept: application/json',
    ],
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_CAINFO => $caBundle,
]);
$paystackResponse = curl_exec($paystack);
$paystackStatus = curl_getinfo($paystack, CURLINFO_HTTP_CODE);
curl_close($paystack);
$refundResult = json_decode($paystackResponse ?: '{}', true) ?: [];

if ($paystackStatus < 200 || $paystackStatus >= 300 || (($refundResult['status'] ?? false) !== true)) {
    $message = $refundResult['message'] ?? 'Paystack refund request failed';
    http_response_code(422);
    echo json_encode(['error' => $message, 'status' => $paystackStatus, 'payload' => $refundResult]);
    exit;
}

[$updateStatus, $updateResponse] = $request('PATCH', '/rest/v1/payments?id=eq.' . rawurlencode($payment['id']), [
    'refund_status' => 'refunded',
    'refund_reason' => $reason,
    'refunded_at' => gmdate('c'),
    'status' => 'paid',
]);

if ($updateStatus >= 400) {
    http_response_code(502);
    echo json_encode(['error' => 'Refund was processed in Paystack but the local record could not be updated', 'status' => $updateStatus, 'detail' => $updateResponse]);
    exit;
}

echo json_encode([
    'success' => true,
    'reference' => $reference,
    'amount' => $paystackAmount / 100,
    'reason' => $reason,
    'paystack_response' => $refundResult,
]);
