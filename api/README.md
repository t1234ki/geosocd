# Paystack webhook setup

The frontend does not create payment records. `paystack-webhook.php` creates a payment only after Paystack sends a signed `charge.success` event.

## Deploy

Deploy `paystack-webhook.php` to a public HTTPS PHP host. Configure these server environment variables:

- `PAYSTACK_SECRET_KEY`: the Paystack test secret key while testing
- `SUPABASE_URL`: the Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role key

In the Paystack dashboard, switch to **Test mode** and set the webhook URL to:

`https://your-domain.example/api/paystack-webhook.php`

Do not use the local Vite URL as the webhook URL. Paystack cannot reach `localhost`.

For local testing, expose a local PHP server through an HTTPS tunnel:

```powershell
php -S 127.0.0.1:8080 -t .
ngrok http 8080
```

Set the generated `https://...ngrok.../api/paystack-webhook.php` URL in Paystack Test mode. Never expose the service-role key or secret key to Vite/browser environment variables.
