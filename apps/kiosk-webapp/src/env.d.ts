/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the client webapp, used to generate QR code join links. */
  readonly VITE_CLIENT_WEBAPP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
