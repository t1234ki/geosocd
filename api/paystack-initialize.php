<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');

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
$input = json_decode(file_get_contents('php://input'), true) ?: [];
$email = filter_var($input['email'] ?? '', FILTER_VALIDATE_EMAIL);
$amount = filter_var($input['amount'] ?? 0, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
$reference = $input['reference'] ?? '';
$metadata = $input['metadata'] ?? [];
$callbackUrl = $input['callback_url'] ?? '';

if (!$secret || !$email || !$amount || !is_string($reference) || !preg_match('/^[A-Za-z0-9.=\-]+$/', $reference) || !is_array($metadata) || ($callbackUrl && !filter_var($callbackUrl, FILTER_VALIDATE_URL))) {
    http_response_code(422);
    echo json_encode(['error' => 'Invalid payment initialization data']);
    exit;
}

$ch = curl_init('https://api.paystack.co/transaction/initialize');
$caBundle = getenv('CURL_CA_BUNDLE') ?: 'C:\\Program Files\\Git\\usr\\ssl\\certs\\ca-bundle.crt';
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode([
        'email' => $email,
        'amount' => $amount,
        'currency' => 'GHS',
        'reference' => $reference,
        'metadata' => $metadata,
        'callback_url' => $callbackUrl ?: null,
    ]),
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $secret],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_CAINFO => $caBundle,
]);
$response = curl_exec($ch);
$curlError = curl_error($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$data = json_decode($response ?: '{}', true) ?: [];
if ($response === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Paystack connection failed', 'detail' => $curlError]);
    exit;
}
if ($status < 200 || $status >= 300 || !($data['status'] ?? false) || empty($data['data']['authorization_url'])) {
    http_response_code(502);
    echo json_encode(['error' => $data['message'] ?? 'Paystack transaction initialization failed']);
    exit;
}

echo json_encode(['authorization_url' => $data['data']['authorization_url'], 'reference' => $reference]);
