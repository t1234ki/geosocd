/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_PAYSTACK_PUBLIC_KEY: string;
  readonly VITE_PAYSTACK_VERIFY_URL?: string;
  readonly VITE_PAYSTACK_INITIALIZE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

