/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHS_API_BASE_URL?: string;
  readonly VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT?: string;
  readonly VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT?: string;
  readonly VITE_OPERATIONS_OIDC_END_SESSION_ENDPOINT?: string;
  readonly VITE_OPERATIONS_OIDC_CLIENT_ID?: string;
  readonly VITE_OPERATIONS_OIDC_SCOPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
